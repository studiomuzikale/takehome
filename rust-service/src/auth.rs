use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::error::AppError;

type HmacSha256 = Hmac<Sha256>;

pub fn verify_authorization_header(
    authorization: Option<&str>,
    raw_body: &[u8],
    secret: &str,
) -> Result<(), AppError> {
    let authorization = authorization.ok_or(AppError::Forbidden)?;
    let digest = authorization
        .strip_prefix("HMAC-SHA256 ")
        .ok_or(AppError::Forbidden)?;

    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::Forbidden);
    }

    let actual = hex::decode(digest).map_err(|_| AppError::Forbidden)?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| AppError::Forbidden)?;
    mac.update(raw_body);
    let expected = mac.finalize().into_bytes();

    if actual.len() == expected.len() && actual.ct_eq(expected.as_slice()).into() {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}
