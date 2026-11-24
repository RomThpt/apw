import Foundation

public enum IntentValidationError: Error, Equatable {
    case malformedRequest
    case invalidOrigin
    case invalidAccount
}

/// An exact HTTPS origin in serialized form: `https://host` or `https://host:port`.
///
/// Validation is strict and never normalises input. Anything that is not already the canonical serialization of an
/// HTTPS origin with a lowercase ASCII DNS host is rejected, including: other schemes, uppercase characters, userinfo,
/// paths (even a trailing `/`), queries, fragments, percent-encoding, IP literals, single-label hosts, trailing dots,
/// non-ASCII hosts (use the `xn--` form), and an explicit default port `:443`.
public struct HTTPSOrigin: Equatable {
    public let serialized: String

    /// `https://` + 253-byte host + `:65535`.
    public static let maxLength = 8 + 253 + 6

    public init(exact candidate: String) throws {
        let bytes = Array(candidate.utf8)
        let scheme = Array("https://".utf8)
        guard bytes.count > scheme.count, bytes.count <= Self.maxLength, bytes.starts(with: scheme) else {
            throw IntentValidationError.invalidOrigin
        }
        let authority = bytes[scheme.count...]
        let parts = authority.split(separator: ASCII.colon, maxSplits: 1, omittingEmptySubsequences: false)
        guard Self.isValidHost(parts[0]) else {
            throw IntentValidationError.invalidOrigin
        }
        if parts.count == 2, !Self.isValidPort(parts[1]) {
            throw IntentValidationError.invalidOrigin
        }
        serialized = candidate
    }

    private static func isValidHost(_ host: ArraySlice<UInt8>) -> Bool {
        guard (1...253).contains(host.count) else { return false }
        let labels = host.split(separator: ASCII.dot, omittingEmptySubsequences: false)
        guard labels.count >= 2 else { return false }
        for label in labels {
            guard (1...63).contains(label.count),
                  label.first != ASCII.hyphen,
                  label.last != ASCII.hyphen,
                  label.allSatisfy(ASCII.isLowercaseLetterDigitHyphen)
            else { return false }
        }
        // A numeric final label can be interpreted as an IPv4 address by browsers, including hexadecimal forms.
        guard let first = labels.last?.first else { return false }
        return ASCII.isLowercaseLetter(first)
    }

    private static func isValidPort(_ port: ArraySlice<UInt8>) -> Bool {
        guard (1...5).contains(port.count), port.allSatisfy(ASCII.isDigit), port.first != ASCII.zero else {
            return false
        }
        let value = port.reduce(0) { $0 * 10 + Int($1 - ASCII.zero) }
        return value <= 65535 && value != 443
    }
}

/// An account identifier shown verbatim in the approval prompt.
///
/// Restricted to 1...128 visible ASCII characters (0x21-0x7E). This excludes whitespace, control characters, line
/// breaks, bidirectional overrides, zero-width and look-alike characters that could make the prompt misleading.
public struct AccountIdentifier: Equatable {
    public let value: String

    public static let maxLength = 128

    public init(exact candidate: String) throws {
        let scalars = candidate.unicodeScalars
        guard !scalars.isEmpty,
              scalars.count <= Self.maxLength,
              scalars.allSatisfy({ (0x21...0x7E).contains($0.value) })
        else {
            throw IntentValidationError.invalidAccount
        }
        value = candidate
    }
}

/// A validated, fictitious sign-in intent. Only obtainable through `parse(_:)`.
public struct SignInIntent: Equatable {
    public let origin: HTTPSOrigin
    public let account: AccountIdentifier

    public static let maxRequestBytes = 4096
    static let requiredFields: Set<String> = ["origin", "account"]

    init(origin: HTTPSOrigin, account: AccountIdentifier) {
        self.origin = origin
        self.account = account
    }

    /// Parses a JSON object containing exactly the string fields `origin` and `account`.
    public static func parse(_ data: Data) throws -> SignInIntent {
        guard !data.isEmpty, data.count <= maxRequestBytes,
              let object = try? JSONSerialization.jsonObject(with: data),
              let fields = object as? [String: Any],
              Set(fields.keys) == requiredFields,
              let origin = fields["origin"] as? String,
              let account = fields["account"] as? String
        else {
            throw IntentValidationError.malformedRequest
        }
        return SignInIntent(origin: try HTTPSOrigin(exact: origin), account: try AccountIdentifier(exact: account))
    }
}

private enum ASCII {
    static let colon = UInt8(ascii: ":")
    static let dot = UInt8(ascii: ".")
    static let hyphen = UInt8(ascii: "-")
    static let zero = UInt8(ascii: "0")

    static func isDigit(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
    }

    static func isLowercaseLetter(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte)
    }

    static func isLowercaseLetterDigitHyphen(_ byte: UInt8) -> Bool {
        isLowercaseLetter(byte) || isDigit(byte) || byte == hyphen
    }
}
