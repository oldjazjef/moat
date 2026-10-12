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
}
