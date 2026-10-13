import Foundation
import Security

struct NativeSessionCredential: Codable, Sendable {
    var token: String
    var expiresAt: String
    var rootUrl: URL
    var owner: NativeOwner
}

@MainActor
protocol SessionCredentialStore {
    func load() throws -> NativeSessionCredential?
    func save(_ credential: NativeSessionCredential) throws
    func remove() throws
}

@MainActor
struct KeychainSessionStore: SessionCredentialStore {
    private let service = "cards.kanban.native-owner-session"
    private let account = "owner"

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    func load() throws -> NativeSessionCredential? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else {
            throw CredentialStorageError(status: status, operation: .load)
        }
        return try JSONDecoder().decode(NativeSessionCredential.self, from: data)
    }

    func save(_ credential: NativeSessionCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw CredentialStorageError(status: update, operation: .save) }
        let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        guard status == errSecSuccess else { throw CredentialStorageError(status: status, operation: .save) }
    }

    func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStorageError(status: status, operation: .remove)
        }
    }
}

struct CredentialStorageError: LocalizedError {
    enum Operation { case load, save, remove }
    let status: OSStatus
    let operation: Operation
    var errorDescription: String? {
        switch operation {
        case .load: "Your saved session could not be opened securely. Try again."
        case .save: "Your session could not be stored securely. Try again."
        case .remove: "Your saved session could not be removed securely. Try again."
        }
    }
}
