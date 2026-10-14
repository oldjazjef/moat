<?php

declare(strict_types=1);

namespace Moat\Gate;

/**
 * The closed list of rejection reasons, shared with libs/core and the conformance vectors
 * (conformance/vectors/crypto/), so a case says exactly which check must fail.
 */
enum RejectionCode: string
{
    case TooLarge = 'too_large';
    case EnvelopeInvalid = 'envelope_invalid';
    case PayloadEncoding = 'payload_encoding';
    case SignatureInvalid = 'signature_invalid';
    case ThresholdNotMet = 'threshold_not_met';
    case PayloadInvalid = 'payload_invalid';
    case GateMismatch = 'gate_mismatch';
    case VersionNotNewer = 'version_not_newer';
    case Expired = 'expired';
    case SecretInvalid = 'secret_invalid';
    case EncodingInvalid = 'encoding_invalid';
    case JsonInvalid = 'json_invalid';
    case ConfigInvalid = 'config_invalid';
    case PolicyInvalid = 'policy_invalid';
    case PolicyViolation = 'policy_violation';
    case PathInvalid = 'path_invalid';
    case OriginForbidden = 'origin_forbidden';
    case PreflightRejected = 'preflight_rejected';
    case BodyInvalid = 'body_invalid';
    // keyfile_invalid and keyfile_locked exist only in Desktop/CLI: a gate never opens a key file.
}
