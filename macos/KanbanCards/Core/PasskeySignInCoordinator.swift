import AuthenticationServices
import Foundation
import AppKit

@MainActor
final class PasskeySignInCoordinator: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    private var controller: ASAuthorizationController?
    private var continuation: CheckedContinuation<NativePasskeyAssertion, any Error>?
    private var anchor: ASPresentationAnchor?
    private var requestID: UUID?

    func assertion(for challenge: NativeSignInChallenge) async throws -> NativePasskeyAssertion {
        guard controller == nil else { throw APIError(message: "Sign-in is already in progress.") }
        guard challenge.relyingPartyIdentifier == "auth.kanban.cards",
              let bytes = Data(base64URL: challenge.challenge), !bytes.isEmpty,
              let expiry = ServerTimestamp.date(from: challenge.expiresAt), expiry > .now else {
            throw APIError(message: "The passkey request expired or could not be verified. Start sign-in again.")
        }
        guard let window = NSApplication.shared.keyWindow ?? NSApplication.shared.mainWindow,
              window.isVisible else {
            throw APIError(message: "Open the board window before signing in.")
        }
        anchor = window
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: challenge.relyingPartyIdentifier)
        let request = provider.createCredentialAssertionRequest(challenge: bytes)
        request.userVerificationPreference = .required
        let authorizationController = ASAuthorizationController(authorizationRequests: [request])
        authorizationController.delegate = self
        authorizationController.presentationContextProvider = self
        controller = authorizationController
        let currentRequestID = UUID()
        requestID = currentRequestID
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                self.controller?.performRequests()
            }
        } onCancel: { [weak self] in
            Task { @MainActor [weak self] in
                // AuthenticationServices completes the delegate after cancel. Keep its anchor
                // alive until that callback and cancel this exact request, never a later one.
                guard self?.requestID == currentRequestID else { return }
                self?.controller?.cancel()
            }
        }
    }

    func cancel() {
        controller?.cancel()
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // The anchor is retained before performRequests and released only after its completion.
        anchor!
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard self.controller === controller else { return }
        guard let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            finish(.failure(APIError(message: "The system did not return a passkey. Try again.")))
            return
        }
        let identifier = assertion.credentialID.base64URLEncodedString()
        finish(.success(NativePasskeyAssertion(id: identifier, rawId: identifier, response: .init(
            authenticatorData: assertion.rawAuthenticatorData.base64URLEncodedString(),
            clientDataJSON: assertion.rawClientDataJSON.base64URLEncodedString(),
            signature: assertion.signature.base64URLEncodedString(),
            userHandle: assertion.userID.base64URLEncodedString()))))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: any Error) {
        guard self.controller === controller else { return }
        if (error as? ASAuthorizationError)?.code == .canceled {
            finish(.failure(CancellationError()))
        } else {
            finish(.failure(APIError(message: "Passkey sign-in could not finish. Try again.")))
        }
    }

    private func finish(_ result: Result<NativePasskeyAssertion, any Error>) {
        let pending = continuation
        continuation = nil
        controller = nil
        anchor = nil
        requestID = nil
        pending?.resume(with: result)
    }
}

extension Data {
    init?(base64URL string: String) {
        guard !string.isEmpty, string.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
            return nil
        }
        let base64 = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        self.init(base64Encoded: base64 + String(repeating: "=", count: (4 - base64.count % 4) % 4))
    }

    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
