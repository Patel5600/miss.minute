//! Pure-Rust ASN.1 DER X.509 certificate chain & Android Key Attestation (`1.3.6.1.4.1.11129.2.1.17`) verifier.
//!
//! Security policy:
//! - Rejects malformed, non-canonical, or indefinite-length DER encodings.
//! - Rejects empty chains, single self-signed/unchained leaf certificates, or mismatched issuer/subject DNs.
//! - Cryptographically verifies every parent->child signature in the chain via `ring::signature`.
//! - Fails closed if EITHER `attestationSecurityLevel` OR `keymasterSecurityLevel` is `Software (0)`.
//! - Verifies exact `attestationChallenge` equality using constant-time comparison.
//! - Optionally verifies the leaf SubjectPublicKeyInfo uncompressed P-256 point matches the enrolled key.

use ring::signature::{
    ECDSA_P256_SHA256_ASN1, ECDSA_P384_SHA384_ASN1, RSA_PKCS1_2048_8192_SHA256,
    RSA_PKCS1_2048_8192_SHA384, UnparsedPublicKey,
};
use subtle::ConstantTimeEq;

/// OID `1.3.6.1.4.1.11129.2.1.17` (Android KeyStore Key Attestation Extension)
const OID_ANDROID_KEY_ATTESTATION: &[u8] =
    &[0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x11];

const OID_EC_PUBLIC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_SECP256R1: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_SECP384R1: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];
const OID_RSA_ENCRYPTION: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

const OID_ECDSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const OID_ECDSA_SHA384: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03];
const OID_RSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
const OID_RSA_SHA384: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttestationSecurityLevel {
    Software = 0,
    TrustedEnvironment = 1,
    StrongBox = 2,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedKeyAttestation {
    pub security_level: AttestationSecurityLevel,
    pub attestation_version: i64,
    pub keymaster_version: i64,
    pub chain_len: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttestationError {
    InvalidChainLength,
    CertificateTooLarge,
    MalformedDer,
    InvalidAlgorithmOrKey,
    PublicKeyMismatch,
    ChainLinkageMismatch,
    InvalidChainSignature,
    MissingAttestationExtension,
    SoftwareBackedRejected,
    ChallengeMismatch,
}

impl std::fmt::Display for AttestationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

#[derive(Clone, Copy)]
struct Tlv<'a> {
    tag: u8,
    raw: &'a [u8],
    value: &'a [u8],
}

fn read_tlv(input: &[u8]) -> Result<(Tlv<'_>, &[u8]), AttestationError> {
    if input.len() < 2 {
        return Err(AttestationError::MalformedDer);
    }
    let tag = input[0];
    // Reject high-tag-number form in X.509 certs where standard tags are single-byte.
    if (tag & 0x1f) == 0x1f {
        return Err(AttestationError::MalformedDer);
    }
    let len_byte = input[1];
    let (len, hdr_len) = if len_byte < 0x80 {
        (len_byte as usize, 2usize)
    } else {
        let count = (len_byte & 0x7f) as usize;
        // Reject indefinite length (0x80) and > 4-byte lengths.
        if count == 0 || count > 4 || input.len() < 2 + count {
            return Err(AttestationError::MalformedDer);
        }
        // Reject non-canonical leading zero byte in definite length.
        if input[2] == 0 {
            return Err(AttestationError::MalformedDer);
        }
        let mut len = 0usize;
        for &b in &input[2..2 + count] {
            len = (len << 8) | (b as usize);
        }
        // Reject long form when short form (< 128) would have worked.
        if len < 0x80 {
            return Err(AttestationError::MalformedDer);
        }
        (len, 2 + count)
    };
    let end = hdr_len
        .checked_add(len)
        .ok_or(AttestationError::MalformedDer)?;
    if end > input.len() {
        return Err(AttestationError::MalformedDer);
    }
    Ok((
        Tlv {
            tag,
            raw: &input[..end],
            value: &input[hdr_len..end],
        },
        &input[end..],
    ))
}

fn read_exact_tlv(input: &[u8], expected_tag: u8) -> Result<Tlv<'_>, AttestationError> {
    let (tlv, rest) = read_tlv(input)?;
    if tlv.tag != expected_tag || !rest.is_empty() {
        return Err(AttestationError::MalformedDer);
    }
    Ok(tlv)
}

fn read_int_i64(bytes: &[u8]) -> Result<i64, AttestationError> {
    if bytes.is_empty() || bytes.len() > 8 {
        return Err(AttestationError::MalformedDer);
    }
    // Check minimal two's-complement ASN.1 integer encoding
    if bytes.len() >= 2
        && ((bytes[0] == 0x00 && (bytes[1] & 0x80) == 0)
            || (bytes[0] == 0xff && (bytes[1] & 0x80) != 0))
    {
        return Err(AttestationError::MalformedDer);
    }
    let mut acc: i64 = if (bytes[0] & 0x80) != 0 { -1 } else { 0 };
    for &b in bytes {
        acc = (acc << 8) | i64::from(b);
    }
    Ok(acc)
}

#[derive(Clone, Copy)]
enum SpkiKeyKind {
    EcP256,
    EcP384,
    Rsa,
}

#[derive(Clone, Copy)]
enum SigAlg {
    EcdsaSha256,
    EcdsaSha384,
    RsaSha256,
    RsaSha384,
}

struct ParsedCert<'a> {
    tbs_raw: &'a [u8],
    issuer_raw: &'a [u8],
    subject_raw: &'a [u8],
    spki_kind: SpkiKeyKind,
    spki_pub_bytes: &'a [u8],
    sig_alg: SigAlg,
    signature_bytes: &'a [u8],
    extensions_der: Option<&'a [u8]>,
}

fn parse_sig_alg(seq_val: &[u8]) -> Result<SigAlg, AttestationError> {
    let (oid, _rest) = read_tlv(seq_val)?;
    if oid.tag != 0x06 {
        return Err(AttestationError::MalformedDer);
    }
    match oid.value {
        OID_ECDSA_SHA256 => Ok(SigAlg::EcdsaSha256),
        OID_ECDSA_SHA384 => Ok(SigAlg::EcdsaSha384),
        OID_RSA_SHA256 => Ok(SigAlg::RsaSha256),
        OID_RSA_SHA384 => Ok(SigAlg::RsaSha384),
        _ => Err(AttestationError::InvalidAlgorithmOrKey),
    }
}

fn parse_spki(spki_val: &[u8]) -> Result<(SpkiKeyKind, &[u8]), AttestationError> {
    let (alg_seq, rest) = read_tlv(spki_val)?;
    if alg_seq.tag != 0x30 {
        return Err(AttestationError::MalformedDer);
    }
    let (alg_oid, alg_params) = read_tlv(alg_seq.value)?;
    if alg_oid.tag != 0x06 {
        return Err(AttestationError::MalformedDer);
    }

    let (bit_string, tail) = read_tlv(rest)?;
    if bit_string.tag != 0x03
        || !tail.is_empty()
        || bit_string.value.len() < 2
        || bit_string.value[0] != 0x00
    {
        return Err(AttestationError::MalformedDer);
    }
    let pub_bytes = &bit_string.value[1..];

    if alg_oid.value == OID_EC_PUBLIC_KEY {
        let (curve_oid, p_tail) = read_tlv(alg_params)?;
        if curve_oid.tag != 0x06 || !p_tail.is_empty() {
            return Err(AttestationError::InvalidAlgorithmOrKey);
        }
        match curve_oid.value {
            OID_SECP256R1 => {
                if pub_bytes.len() != 65 || pub_bytes[0] != 0x04 {
                    return Err(AttestationError::InvalidAlgorithmOrKey);
                }
                Ok((SpkiKeyKind::EcP256, pub_bytes))
            }
            OID_SECP384R1 => {
                if pub_bytes.len() != 97 || pub_bytes[0] != 0x04 {
                    return Err(AttestationError::InvalidAlgorithmOrKey);
                }
                Ok((SpkiKeyKind::EcP384, pub_bytes))
            }
            _ => Err(AttestationError::InvalidAlgorithmOrKey),
        }
    } else if alg_oid.value == OID_RSA_ENCRYPTION {
        Ok((SpkiKeyKind::Rsa, pub_bytes))
    } else {
        Err(AttestationError::InvalidAlgorithmOrKey)
    }
}

fn parse_certificate(der: &[u8]) -> Result<ParsedCert<'_>, AttestationError> {
    let cert_seq = read_exact_tlv(der, 0x30)?;
    let (tbs, rest) = read_tlv(cert_seq.value)?;
    if tbs.tag != 0x30 {
        return Err(AttestationError::MalformedDer);
    }
    let (outer_sig_alg_tlv, rest) = read_tlv(rest)?;
    if outer_sig_alg_tlv.tag != 0x30 {
        return Err(AttestationError::MalformedDer);
    }
    let outer_sig_alg = parse_sig_alg(outer_sig_alg_tlv.value)?;
    let (sig_bits, tail) = read_tlv(rest)?;
    if sig_bits.tag != 0x03
        || !tail.is_empty()
        || sig_bits.value.len() < 2
        || sig_bits.value[0] != 0x00
    {
        return Err(AttestationError::MalformedDer);
    }

    let mut cur = tbs.value;
    // Optional [0] version
    let (first, after_first) = read_tlv(cur)?;
    if first.tag == 0xA0 {
        cur = after_first;
    }
    // serialNumber (INTEGER)
    let (serial, r) = read_tlv(cur)?;
    if serial.tag != 0x02 {
        return Err(AttestationError::MalformedDer);
    }
    // tbs.signature AlgorithmIdentifier
    let (inner_sig_alg, r) = read_tlv(r)?;
    if inner_sig_alg.tag != 0x30 || parse_sig_alg(inner_sig_alg.value)? as u8 != outer_sig_alg as u8
    {
        return Err(AttestationError::MalformedDer);
    }
    // issuer Name
    let (issuer, r) = read_tlv(r)?;
    if issuer.tag != 0x30 {
        return Err(AttestationError::MalformedDer);
    }
    // validity Validity
    let (validity, r) = read_tlv(r)?;
    if validity.tag != 0x30 {
        return Err(AttestationError::MalformedDer);
    }
    // subject Name
    let (subject, r) = read_tlv(r)?;
    if subject.tag != 0x30 {
        return Err(AttestationError::MalformedDer);
    }
    // subjectPublicKeyInfo
    let (spki, mut r) = read_tlv(r)?;
    if spki.tag != 0x30 {
        return Err(AttestationError::MalformedDer);
    }
    let (spki_kind, spki_pub_bytes) = parse_spki(spki.value)?;

    let mut extensions_der = None;
    while !r.is_empty() {
        let (field, next) = read_tlv(r)?;
        match field.tag {
            0x81 | 0x82 => {} // optional issuerUniqueID / subjectUniqueID
            0xA3 => {
                extensions_der = Some(read_exact_tlv(field.value, 0x30)?.value);
            }
            _ => return Err(AttestationError::MalformedDer),
        }
        r = next;
    }

    Ok(ParsedCert {
        tbs_raw: tbs.raw,
        issuer_raw: issuer.raw,
        subject_raw: subject.raw,
        spki_kind,
        spki_pub_bytes,
        sig_alg: outer_sig_alg,
        signature_bytes: &sig_bits.value[1..],
        extensions_der,
    })
}

fn verify_signature_by(
    child: &ParsedCert<'_>,
    issuer: &ParsedCert<'_>,
) -> Result<(), AttestationError> {
    let verifier: UnparsedPublicKey<&[u8]> = match (child.sig_alg, issuer.spki_kind) {
        (SigAlg::EcdsaSha256, SpkiKeyKind::EcP256) => {
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, issuer.spki_pub_bytes)
        }
        (SigAlg::EcdsaSha384, SpkiKeyKind::EcP384) => {
            UnparsedPublicKey::new(&ECDSA_P384_SHA384_ASN1, issuer.spki_pub_bytes)
        }
        (SigAlg::RsaSha256, SpkiKeyKind::Rsa) => {
            UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, issuer.spki_pub_bytes)
        }
        (SigAlg::RsaSha384, SpkiKeyKind::Rsa) => {
            UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA384, issuer.spki_pub_bytes)
        }
        _ => return Err(AttestationError::InvalidChainSignature),
    };
    verifier
        .verify(child.tbs_raw, child.signature_bytes)
        .map_err(|_| AttestationError::InvalidChainSignature)
}

fn parse_security_level(
    tag: u8,
    bytes: &[u8],
) -> Result<AttestationSecurityLevel, AttestationError> {
    // ENUMERATED (0x0A) or INTEGER (0x02)
    if tag != 0x0A && tag != 0x02 {
        return Err(AttestationError::MalformedDer);
    }
    match read_int_i64(bytes)? {
        0 => Ok(AttestationSecurityLevel::Software),
        1 => Ok(AttestationSecurityLevel::TrustedEnvironment),
        2 => Ok(AttestationSecurityLevel::StrongBox),
        _ => Err(AttestationError::MalformedDer),
    }
}

fn parse_android_attestation_extension(
    extensions_der: &[u8],
    expected_challenge: &[u8],
) -> Result<(AttestationSecurityLevel, i64, i64), AttestationError> {
    let mut cur = extensions_der;
    let mut found_extn_value: Option<&[u8]> = None;
    while !cur.is_empty() {
        let (ext_seq, next) = read_tlv(cur)?;
        cur = next;
        if ext_seq.tag != 0x30 {
            return Err(AttestationError::MalformedDer);
        }
        let (oid, er) = read_tlv(ext_seq.value)?;
        if oid.tag != 0x06 {
            return Err(AttestationError::MalformedDer);
        }
        let (maybe_bool, er2) = read_tlv(er)?;
        let val_tlv = if maybe_bool.tag == 0x01 {
            read_exact_tlv(er2, 0x04)?
        } else {
            if !er2.is_empty() || maybe_bool.tag != 0x04 {
                return Err(AttestationError::MalformedDer);
            }
            maybe_bool
        };
        if oid.value == OID_ANDROID_KEY_ATTESTATION {
            found_extn_value = Some(val_tlv.value);
            break;
        }
    }

    let key_desc_bytes = found_extn_value.ok_or(AttestationError::MissingAttestationExtension)?;
    let key_desc = read_exact_tlv(key_desc_bytes, 0x30)?;
    let (att_ver_tlv, r) = read_tlv(key_desc.value)?;
    if att_ver_tlv.tag != 0x02 {
        return Err(AttestationError::MalformedDer);
    }
    let att_ver = read_int_i64(att_ver_tlv.value)?;
    let (att_level_tlv, r) = read_tlv(r)?;
    let att_level = parse_security_level(att_level_tlv.tag, att_level_tlv.value)?;

    let (km_ver_tlv, r) = read_tlv(r)?;
    if km_ver_tlv.tag != 0x02 {
        return Err(AttestationError::MalformedDer);
    }
    let km_ver = read_int_i64(km_ver_tlv.value)?;
    let (km_level_tlv, r) = read_tlv(r)?;
    let km_level = parse_security_level(km_level_tlv.tag, km_level_tlv.value)?;

    let (challenge_tlv, r) = read_tlv(r)?;
    if challenge_tlv.tag != 0x04 {
        return Err(AttestationError::MalformedDer);
    }
    // Fail closed if EITHER attestation OR keymaster reports Software (or mismatched level)!
    if att_level == AttestationSecurityLevel::Software
        || km_level == AttestationSecurityLevel::Software
    {
        return Err(AttestationError::SoftwareBackedRejected);
    }

    // Consume uniqueId (OCTET STRING), softwareEnforced (SEQUENCE), teeEnforced (SEQUENCE)
    let (unique_id, r) = read_tlv(r)?;
    let (sw_enf, r) = read_tlv(r)?;
    let (tee_enf, tail) = read_tlv(r)?;
    if unique_id.tag != 0x04 || sw_enf.tag != 0x30 || tee_enf.tag != 0x30 || !tail.is_empty() {
        return Err(AttestationError::MalformedDer);
    }

    if expected_challenge.is_empty()
        || challenge_tlv.value.len() != expected_challenge.len()
        || challenge_tlv.value.ct_eq(expected_challenge).unwrap_u8() != 1
    {
        return Err(AttestationError::ChallengeMismatch);
    }

    let security_level = if att_level == AttestationSecurityLevel::StrongBox
        && km_level == AttestationSecurityLevel::StrongBox
    {
        AttestationSecurityLevel::StrongBox
    } else {
        AttestationSecurityLevel::TrustedEnvironment
    };

    Ok((security_level, att_ver, km_ver))
}

/// Verifies an Android KeyStore DER certificate chain (leaf -> intermediate... -> root),
/// checks cryptographic signatures across the chain, enforces hardware TEE/StrongBox backing,
/// binds the attestation challenge constant-time, and matches the enrolled leaf P-256 public key.
pub fn verify_android_key_attestation(
    cert_chain_ders: &[&[u8]],
    expected_challenge: &[u8],
    expected_leaf_sec1_pubkey: Option<&[u8]>,
) -> Result<VerifiedKeyAttestation, AttestationError> {
    if cert_chain_ders.len() < 2 || cert_chain_ders.len() > 16 {
        return Err(AttestationError::InvalidChainLength);
    }
    if cert_chain_ders
        .iter()
        .any(|c| c.is_empty() || c.len() > 16 * 1024)
    {
        return Err(AttestationError::CertificateTooLarge);
    }

    let mut parsed = Vec::with_capacity(cert_chain_ders.len());
    for der in cert_chain_ders {
        parsed.push(parse_certificate(der)?);
    }

    // Verify subject/issuer chain linkage and cryptographic signatures from leaf up to root.
    for idx in 0..(parsed.len() - 1) {
        let child = &parsed[idx];
        let issuer = &parsed[idx + 1];
        if child.issuer_raw != issuer.subject_raw {
            return Err(AttestationError::ChainLinkageMismatch);
        }
        verify_signature_by(child, issuer)?;
    }

    // Also verify root self-signature if root is self-issued.
    let root = &parsed[parsed.len() - 1];
    if root.issuer_raw == root.subject_raw {
        verify_signature_by(root, root)?;
    }

    let leaf = &parsed[0];
    if let Some(expected_pub) = expected_leaf_sec1_pubkey
        && (leaf.spki_pub_bytes.len() != expected_pub.len()
            || leaf.spki_pub_bytes.ct_eq(expected_pub).unwrap_u8() != 1)
    {
        return Err(AttestationError::PublicKeyMismatch);
    }

    let ext_der = leaf
        .extensions_der
        .ok_or(AttestationError::MissingAttestationExtension)?;
    let (security_level, attestation_version, keymaster_version) =
        parse_android_attestation_extension(ext_der, expected_challenge)?;

    Ok(VerifiedKeyAttestation {
        security_level,
        attestation_version,
        keymaster_version,
        chain_len: parsed.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, KeyPair},
    };

    fn der_tlv(tag: u8, content: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        let len = content.len();
        if len < 0x80 {
            out.push(len as u8);
        } else if len <= 0xff {
            out.push(0x81);
            out.push(len as u8);
        } else {
            out.push(0x82);
            out.push((len >> 8) as u8);
            out.push(len as u8);
        }
        out.extend_from_slice(content);
        out
    }

    fn der_seq(parts: &[Vec<u8>]) -> Vec<u8> {
        let joined: Vec<u8> = parts.iter().flat_map(|p| p.iter().copied()).collect();
        der_tlv(0x30, &joined)
    }

    fn der_oid(oid_bytes: &[u8]) -> Vec<u8> {
        der_tlv(0x06, oid_bytes)
    }

    fn der_name(cn: &str) -> Vec<u8> {
        let attr = der_seq(&[der_oid(&[0x55, 0x04, 0x03]), der_tlv(0x0c, cn.as_bytes())]);
        let rdn = der_tlv(0x31, &attr);
        der_seq(&[rdn])
    }

    fn der_ec_p256_spki(pub_sec1: &[u8]) -> Vec<u8> {
        let alg = der_seq(&[der_oid(OID_EC_PUBLIC_KEY), der_oid(OID_SECP256R1)]);
        let mut bits = vec![0x00];
        bits.extend_from_slice(pub_sec1);
        der_seq(&[alg, der_tlv(0x03, &bits)])
    }

    fn android_attestation_ext(att_level: u8, km_level: u8, challenge: &[u8]) -> Vec<u8> {
        let key_desc = der_seq(&[
            der_tlv(0x02, &[3]),          // attestationVersion = 3
            der_tlv(0x0A, &[att_level]),  // attestationSecurityLevel
            der_tlv(0x02, &[4]),          // keymasterVersion = 4
            der_tlv(0x0A, &[km_level]),   // keymasterSecurityLevel
            der_tlv(0x04, challenge),     // attestationChallenge
            der_tlv(0x04, &[1, 2, 3, 4]), // uniqueId
            der_seq(&[]),                 // softwareEnforced
            der_seq(&[]),                 // teeEnforced
        ]);
        der_seq(&[
            der_oid(OID_ANDROID_KEY_ATTESTATION),
            der_tlv(0x04, &key_desc),
        ])
    }

    fn build_signed_cert(
        issuer_cn: &str,
        subject_cn: &str,
        subject_pub: &[u8],
        signer: &EcdsaKeyPair,
        ext: Option<Vec<u8>>,
    ) -> Vec<u8> {
        let sig_alg = der_seq(&[der_oid(OID_ECDSA_SHA256)]);
        let validity = der_seq(&[
            der_tlv(0x17, b"260101000000Z"),
            der_tlv(0x17, b"360101000000Z"),
        ]);
        let mut tbs_parts = vec![
            der_tlv(0xA0, &der_tlv(0x02, &[2])),
            der_tlv(0x02, &[1]),
            sig_alg.clone(),
            der_name(issuer_cn),
            validity,
            der_name(subject_cn),
            der_ec_p256_spki(subject_pub),
        ];
        if let Some(ext_seq) = ext {
            let exts = der_seq(&[ext_seq]);
            tbs_parts.push(der_tlv(0xA3, &exts));
        }
        let tbs = der_seq(&tbs_parts);
        let rng = SystemRandom::new();
        let sig = signer.sign(&rng, &tbs).unwrap();
        let mut sig_bits = vec![0x00];
        sig_bits.extend_from_slice(sig.as_ref());
        der_seq(&[tbs, sig_alg, der_tlv(0x03, &sig_bits)])
    }

    #[test]
    fn accepts_hardware_tee_and_strongbox_and_rejects_software_or_wrong_challenge() {
        let rng = SystemRandom::new();
        let root_pkcs8 =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        let root_kp =
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, root_pkcs8.as_ref(), &rng)
                .unwrap();
        let leaf_pkcs8 =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        let leaf_kp =
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, leaf_pkcs8.as_ref(), &rng)
                .unwrap();

        let root_cert = build_signed_cert(
            "AttestationRoot",
            "AttestationRoot",
            root_kp.public_key().as_ref(),
            &root_kp,
            None,
        );
        let challenge = b"miss-minutes-attest-nonce-0123456789";

        // 1. Valid TEE (1)
        let tee_leaf = build_signed_cert(
            "AttestationRoot",
            "DeviceKey",
            leaf_kp.public_key().as_ref(),
            &root_kp,
            Some(android_attestation_ext(1, 1, challenge)),
        );
        let res = verify_android_key_attestation(
            &[&tee_leaf, &root_cert],
            challenge,
            Some(leaf_kp.public_key().as_ref()),
        )
        .unwrap();
        assert_eq!(
            res.security_level,
            AttestationSecurityLevel::TrustedEnvironment
        );

        // 2. Valid StrongBox (2)
        let sb_leaf = build_signed_cert(
            "AttestationRoot",
            "DeviceKey",
            leaf_kp.public_key().as_ref(),
            &root_kp,
            Some(android_attestation_ext(2, 2, challenge)),
        );
        let sb = verify_android_key_attestation(
            &[&sb_leaf, &root_cert],
            challenge,
            Some(leaf_kp.public_key().as_ref()),
        )
        .unwrap();
        assert_eq!(sb.security_level, AttestationSecurityLevel::StrongBox);

        // 3. Reject Software (0) even with valid signature and challenge
        let sw_leaf = build_signed_cert(
            "AttestationRoot",
            "DeviceKey",
            leaf_kp.public_key().as_ref(),
            &root_kp,
            Some(android_attestation_ext(0, 1, challenge)),
        );
        assert_eq!(
            verify_android_key_attestation(
                &[&sw_leaf, &root_cert],
                challenge,
                Some(leaf_kp.public_key().as_ref())
            ),
            Err(AttestationError::SoftwareBackedRejected)
        );

        // 4. Reject mismatched challenge
        assert_eq!(
            verify_android_key_attestation(
                &[&tee_leaf, &root_cert],
                b"wrong-nonce",
                Some(leaf_kp.public_key().as_ref())
            ),
            Err(AttestationError::ChallengeMismatch)
        );

        // 5. Reject single leaf without CA chain
        assert_eq!(
            verify_android_key_attestation(
                &[&tee_leaf],
                challenge,
                Some(leaf_kp.public_key().as_ref())
            ),
            Err(AttestationError::InvalidChainLength)
        );
    }
}
