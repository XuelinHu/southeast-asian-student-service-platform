const OIDC_ISSUER = process.env.OIDC_ISSUER || 'https://192.168.1.9:8042/realms/front';
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || 'sea-student-platform-web';

let remoteJwks;

async function verifyOidcIdToken(token, nonce, options = {}) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 16_384) {
    throw new Error('Invalid identity token');
  }
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 256) {
    throw new Error('Invalid OIDC nonce');
  }

  const issuer = options.issuer || OIDC_ISSUER;
  const clientId = options.clientId || OIDC_CLIENT_ID;
  if (new URL(issuer).protocol !== 'https:') throw new Error('OIDC issuer must use HTTPS');
  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  const jwks = options.jwks || (remoteJwks ||= createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`)));
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: clientId,
    algorithms: ['RS256']
  });
  if ((payload.azp && payload.azp !== clientId) || payload.nonce !== nonce
    || typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('Identity token is not issued for this application');
  }
  return { subject: payload.sub };
}

module.exports = { OIDC_ISSUER, OIDC_CLIENT_ID, verifyOidcIdToken };
