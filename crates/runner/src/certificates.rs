//! The session's own certificates, for the names whose TLS it answers itself (see
//! [`proxy`](aperture_runner::proxy)). They all have one key, made when the session
//! starts and kept nowhere, and the session's browser is started knowing that key: it
//! takes a certificate with it for any name, and no other browser does.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use anyhow::Context;
use base64::Engine as _;
use rcgen::{CertificateParams, KeyPair, PublicKeyData};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_native_tls::{TlsAcceptor, TlsStream};

/// How many names' certificates are kept made: a rule may cover any number of names.
const KEPT: usize = 256;

pub struct Certificates {
    key: KeyPair,
    made: Mutex<HashMap<String, TlsAcceptor>>,
}

impl Certificates {
    pub fn new() -> anyhow::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            key: KeyPair::generate().context("the session's key was not made")?,
            made: Mutex::default(),
        }))
    }

    /// What names the key to a browser: the hash of its public half, as Chromium's
    /// `--ignore-certificate-errors-spki-list` takes it.
    pub fn key_hash(&self) -> String {
        let hash = Sha256::digest(self.key.subject_public_key_info());
        base64::engine::general_purpose::STANDARD.encode(hash)
    }

    /// Answers the TLS a browser starts on `stream`, as `name`.
    pub async fn accept<S>(&self, name: &str, stream: S) -> anyhow::Result<TlsStream<S>>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let acceptor = self.acceptor(name)?;
        Ok(acceptor.accept(stream).await?)
    }

    fn acceptor(&self, name: &str) -> anyhow::Result<TlsAcceptor> {
        let mut made = self.made.lock().expect("not poisoned");
        if let Some(acceptor) = made.get(name) {
            return Ok(acceptor.clone());
        }
        let certificate = CertificateParams::new([name.to_owned()])?.self_signed(&self.key)?;
        let identity = native_tls::Identity::from_pkcs8(
            certificate.pem().as_bytes(),
            self.key.serialize_pem().as_bytes(),
        )?;
        let acceptor = TlsAcceptor::from(native_tls::TlsAcceptor::new(identity)?);
        if made.len() >= KEPT {
            made.clear();
        }
        made.insert(name.to_owned(), acceptor.clone());
        Ok(acceptor)
    }
}
