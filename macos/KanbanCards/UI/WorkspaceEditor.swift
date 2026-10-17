import SwiftUI

struct WorkspaceEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onCreated: (Workspace) -> Void
    @State private var name = ""
    @State private var slug = ""
    @State private var creating = false
    @State private var errorMessage: String?
    @State private var creationTask: Task<Void, Never>?
    @FocusState private var nameFocused: Bool

    private var workspaceName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var workspaceSlug: String { slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    private var validationMessage: String? {
        if !workspaceName.isEmpty && (workspaceName.utf16.count > 120 || workspaceName.unicodeScalars.contains(where: { $0.value == 0 || $0.value == 10 || $0.value == 13 })) {
            return "Use a name of 120 characters or fewer on one line."
        }
        if !workspaceSlug.isEmpty {
            let reserved = ["api", "app", "auth", "admin", "www"]
            if reserved.contains(workspaceSlug) { return "Choose a different Workspace address." }
            if workspaceSlug.range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", options: .regularExpression) == nil {
                return "Use 1–63 letters, numbers, or hyphens. Start and end with a letter or number."
            }
        }
        return nil
    }
    private var canSubmit: Bool {
        !creating && model.canCreateWorkspace && !workspaceName.isEmpty && !workspaceSlug.isEmpty && validationMessage == nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .accessibilityIdentifier("workspace.name")
                        .focused($nameFocused)
                    HStack {
                        TextField("Address", text: $slug)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("workspace.slug")
                        Text(".kanban.cards")
                    }
                } footer: {
                    Text("Choose the web address for this Workspace. Use letters, numbers, and hyphens.")
                }
                .disabled(creating)
                if let message = errorMessage ?? validationMessage {
                    Text(message)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("workspace.error")
                }
                if creating { ProgressView("Creating Workspace") }
            }
            .formStyle(.grouped)
            .frame(minWidth: 480, idealWidth: 520, minHeight: 300)
            .navigationTitle("New Workspace")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .disabled(creating)
                        .accessibilityIdentifier("workspace.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { create() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(!canSubmit)
                        .accessibilityIdentifier("workspace.create")
                }
            }
        }
        .interactiveDismissDisabled(creating)
        .onAppear { nameFocused = true }
        .onDisappear { creationTask?.cancel() }
        .onChange(of: name) { _, _ in errorMessage = nil }
        .onChange(of: slug) { _, _ in errorMessage = nil }
        .onChange(of: model.sessionID) { _, _ in creationTask?.cancel(); dismiss() }
        .onChange(of: model.signedIn) { _, signedIn in if !signedIn { creationTask?.cancel(); dismiss() } }
    }

    private func create() {
        guard canSubmit else { return }
        let session = model.sessionID
        let submittedName = workspaceName
        let submittedSlug = workspaceSlug
        creating = true
        errorMessage = nil
        creationTask = Task {
            defer { creating = false }
            do {
                let workspace = try await model.createWorkspace(name: submittedName, slug: submittedSlug)
                guard model.signedIn, model.sessionID == session, !Task.isCancelled else { return }
                onCreated(workspace)
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                guard model.signedIn, model.sessionID == session, !Task.isCancelled else { return }
                errorMessage = error.localizedDescription
            }
        }
    }
}
