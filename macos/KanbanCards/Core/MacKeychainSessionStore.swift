import Foundation
import Security

/// The Mac has its own revocable bearer and never touches the iPhone Keychain item.
@MainActor
struct MacKeychainSessionStore: SessionCredentialStore {
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "cards.kanban.macos-owner-session",
         kSecAttrAccount as String: "owner",
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
        let attributes: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(credential),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else {
            throw CredentialStorageError(status: update, operation: .save)
        }
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
