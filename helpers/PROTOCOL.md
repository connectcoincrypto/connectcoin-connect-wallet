# Persistent claims helper protocol 3

The initial `ready` frame retains `protocol: 3` and `roots: 1` and must include
`security: {"rsaPublicExponentMaxBits": 64}`. The desktop rejects a missing or
different limit before sending DNS/claim requests and asks for a helper rebuild.
One-shot claims and RSA probes use the suffix `--require-rsa-exponent-64`;
older helpers reject it before processing input or starting network work.
Proof/result formats and the probe's fixed response fields are unchanged.

An attempt emits `started` when TCP starts, `capture` when that capture finishes,
then one terminal `attempt` result. The terminal result repeats the capture's
status, elapsed seconds and exact successful-connection count. A failed capture
does not consume the successful-capture budget. Cancellation, retry scheduling,
proof verification and the ten-second connection deadline are unchanged.

The terminal result's optional `message` contains only a fixed description:

- `TLS connection timed out` for socket timeout exceptions or expiry of the
  capture's absolute handshake deadline.
- `TLS capture or proof validation failed` for other capture/verification errors.
- `TLS capture cancelled` for cancelled captures.
- `Public DNS resolution is required` when the attempt could not start.

The desktop accepts these descriptions and replaces any other supplied message
with the generic capture failure. Fatal `error` frames use a fixed desktop
description too. Exception text, certificates, peer data and socket details are
never included in these descriptions. The existing diagnostics classifier maps
`TLS connection timed out` to `timeout` without changing the protocol version or
attempt frame shape; generic failure descriptions remain accepted once the
helper has passed the startup security-capability check.
