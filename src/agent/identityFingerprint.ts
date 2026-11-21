/** Short comparison code for the out-of-band device pairing ceremony. */
export async function pairingSourceFingerprint(ownerId: string, sourceDeviceId: string, sourcePublicKey: string): Promise<string> {
  if (!ownerId || !sourceDeviceId || sourcePublicKey.length > 256) throw new Error('Pairing identity is invalid.');
  const key = Uint8Array.from(atob(sourcePublicKey), char => char.charCodeAt(0));
  if (key.length !== 65 || key[0] !== 4) throw new Error('Pairing source key is not a P-256 public key.');
  const prefix = new TextEncoder().encode(`miss-minutes-pair-source-fingerprint-v1\0${ownerId}\0${sourceDeviceId}\0`);
  const input = new Uint8Array(prefix.length + key.length);
  input.set(prefix); input.set(key, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(digest.slice(0, 10), byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('').match(/.{1,4}/g)!.join('-');
}
