//! Small cryptographic helpers shared by the OAuth sign-ins and the encrypted token store:
//! CSPRNG tokens, PKCE (RFC 7636, S256) and authenticated encryption for data at rest.
//!
//! The AES-256-GCM key comes from the OS credential vault (`secrets::get_or_create_file_key`);
//! only the sealed blob is written to disk. This keeps large token records off the Windows
//! Credential Manager (which caps entries well below a full OAuth record) while still
//! protecting them at rest.

use aes_gcm::{
    aead::{Aead, KeyInit, Nonce},
    Aes256Gcm, Key,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};

/// Version byte prefixing every sealed blob, so the on-disk format can evolve.
const SEAL_V1: u8 = 1;
const NONCE_LEN: usize = 12;

/// Fills a buffer with cryptographically secure random bytes.
pub fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
    let mut buffer = vec![0_u8; len];
    getrandom::getrandom(&mut buffer).map_err(|error| format!("Secure randomness is unavailable: {error}"))?;
    Ok(buffer)
}

/// A URL-safe, unpadded random token (base64url of `byte_len` random bytes). Used for OAuth
/// `state`, OIDC `nonce` and the PKCE verifier.
pub fn random_token(byte_len: usize) -> Result<String, String> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes(byte_len)?))
}

/// Returns a PKCE `(verifier, challenge)` pair using the S256 method. The verifier is a
/// 64-byte URL-safe token (well within the 43–128 character range); the challenge is the
/// base64url-unpadded SHA-256 of the verifier's ASCII bytes.
pub fn pkce_pair() -> Result<(String, String), String> {
    let verifier = random_token(64)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Ok((verifier, challenge))
}

/// Seals `plaintext` with AES-256-GCM under `key` (which must be 32 bytes). The output is
/// `version || nonce || ciphertext+tag`.
pub fn seal(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    if key.len() != 32 {
        return Err("The sealing key must be 256 bits.".to_owned());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes = random_bytes(NONCE_LEN)?;
    let nonce = Nonce::<Aes256Gcm>::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| "Encryption failed.".to_owned())?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    out.push(SEAL_V1);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Opens a blob produced by [`seal`]. Returns an error if the key is wrong, the blob was
/// tampered with, or the format is unrecognized.
pub fn open(key: &[u8], blob: &[u8]) -> Result<Vec<u8>, String> {
    if key.len() != 32 {
        return Err("The sealing key must be 256 bits.".to_owned());
    }
    if blob.len() < 1 + NONCE_LEN || blob[0] != SEAL_V1 {
        return Err("The stored credential is not in a recognized format.".to_owned());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::<Aes256Gcm>::from_slice(&blob[1..1 + NONCE_LEN]);
    cipher
        .decrypt(nonce, &blob[1 + NONCE_LEN..])
        .map_err(|_| "The stored credential could not be decrypted (wrong key or modified).".to_owned())
}
