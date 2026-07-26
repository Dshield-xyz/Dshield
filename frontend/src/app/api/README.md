# API Documentation

This directory contains Next.js API routes used by the frontend. Below are the request/response contracts for each endpoint, including their environment variable dependencies.

## 1. `/api/faucet`

Mints test USDC to a recipient using the issuer secret.

**Method:** `POST`

### Environment Variables
* `USDC_ISSUER_SECRET` (Required)
* `NEXT_PUBLIC_RPC_URL` (Optional, defaults to local RPC)
* `NEXT_PUBLIC_NETWORK_PASSPHRASE` (Optional)
* `NEXT_PUBLIC_USDC_CODE` (Optional, defaults to USDC)

See the root `.env.local` or main README for setup instructions on these variables.

### Request
```json
{
  "address": "string (Ed25519 public key)",
  "amount": "string | number"
}
```

### Success Response (200 OK)
```json
{
  "hash": "string (transaction hash)",
  "amount": "string (amount minted in 7-decimal stroops)"
}
```

### Error Responses
* **503 Service Unavailable**
  * `{"error": "Faucet is not configured (USDC_ISSUER_SECRET unset)."}`
* **429 Too Many Requests**
  * `{"error": "Too many faucet requests. Try again later."}` (Includes `Retry-After` header)
* **400 Bad Request**
  * `{"error": "Invalid request body."}`
  * `{"error": "Invalid recipient address."}`
  * `{"error": "Amount must be positive."}`
  * `{"error": "Faucet simulation failed: <details>"}`
* **500 Internal Server Error**
  * `{"error": "Faucet transaction submission failed."}`
  * `{"error": "Faucet transaction did not succeed (<status>)."}`
  * `{"error": "Faucet failed: <details>"}`

---

## 2. `/api/relay-withdraw`

Submits a withdrawal on the user's behalf, paying the transaction fee from the relayer account.

**Method:** `POST`

### Environment Variables
* `RELAYER_SECRET` (Required)
* `NEXT_PUBLIC_RPC_URL` (Optional)
* `NEXT_PUBLIC_NETWORK_PASSPHRASE` (Optional)

See the root `.env.local` or main README for setup instructions on these variables.

### Request
```json
{
  "poolId": "string (contract ID)",
  "recipient": "string (Ed25519 public key)",
  "publicInputs": "string (hex encoded)",
  "proof": "string (hex encoded)"
}
```

### Success Response (200 OK)
```json
{
  "hash": "string (transaction hash)",
  "relayer": "string (relayer public key)"
}
```

### Error Responses
* **503 Service Unavailable**
  * `{"error": "Relayer is not configured (RELAYER_SECRET unset).", "code": "no_relayer"}`
* **429 Too Many Requests**
  * `{"error": "Too many relay requests. Try again later.", "code": "rate_limited"}` (Includes `Retry-After` header)
* **400 Bad Request**
  * `{"error": "Invalid request body."}`
  * `{"error": "Invalid pool id."}`
  * `{"error": "Invalid recipient address."}`
  * `{"error": "publicInputs and proof must be hex strings."}`
  * `{"error": "Withdrawal simulation failed: <details>"}`
* **500 Internal Server Error**
  * `{"error": "Relayed withdrawal submission failed."}`
  * `{"error": "Relayed withdrawal did not succeed (<status>)."}`
  * `{"error": "Relayed withdrawal failed: <details>"}`

---

## 3. `/api/register-kyc`

Registers a KYC hash, granting "compliance-verified" status on the smart contract.

**Method:** `POST`

### Environment Variables
* `COMPLIANCE_ADMIN_SECRET` (Required)
* `NEXT_PUBLIC_COMPLIANCE_CONTRACT_ID` (Required)
* `KYC_ADMIN_API_KEY` (Required)
* `NEXT_PUBLIC_RPC_URL` (Optional)
* `NEXT_PUBLIC_NETWORK_PASSPHRASE` (Optional)

See the root `.env.local` or main README for setup instructions on these variables.

### Request Headers
* `x-admin-key`: Must match the `KYC_ADMIN_API_KEY` environment variable.

### Request
```json
{
  "kycHash": "string (64 hex characters)"
}
```

### Success Response (200 OK)
```json
{
  "hash": "string (transaction hash)"
}
```

### Error Responses
* **503 Service Unavailable**
  * `{"error": "KYC registration is not configured (COMPLIANCE_ADMIN_SECRET unset)."}`
  * `{"error": "Compliance contract not configured."}`
  * `{"error": "KYC registration is not configured (KYC_ADMIN_API_KEY unset)."}`
* **401 Unauthorized**
  * `{"error": "Unauthorized."}` (Invalid or missing `x-admin-key` header)
* **400 Bad Request**
  * `{"error": "Invalid request body."}`
  * `{"error": "kycHash must be exactly 64 hex characters (32 bytes)."}`
  * `{"error": "Simulation failed: <details>"}`
* **500 Internal Server Error**
  * `{"error": "KYC registration transaction rejected by the network."}`
  * `{"error": "KYC registration failed on-chain (<status>)."}`
  * `{"error": "KYC registration failed: <details>"}`
