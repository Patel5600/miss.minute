import SwiftUI
import UniformTypeIdentifiers
import UserNotifications

@MainActor
final class CompanionModel: ObservableObject {
    @Published var monitoringEnabled = UserDefaults.standard.bool(forKey: "missMinutes.monitoringEnabled")
    @Published var selectedFolder = "No folder selected"
    @Published var status = "Select a folder and enable periodic metadata refresh."
    @Published var isRefreshing = false

    func refreshNow() {
        isRefreshing = true
        status = "Reading metadata from the owner-selected folder…"
        Task.detached(priority: .utility) {
            do {
                try MetadataRefresh.refreshMetadata()
                await MainActor.run {
                    self.status = "Metadata refresh completed."
                    self.isRefreshing = false
                }
            } catch {
                await MainActor.run {
                    self.status = error.localizedDescription
                    self.isRefreshing = false
                }
            }
        }
    }

    func setMonitoring(_ enabled: Bool) {
        monitoringEnabled = enabled
        MetadataRefresh.setMonitoring(enabled)
        status = enabled
            ? "Periodic refresh is enabled. iOS chooses whether and when background refresh runs."
            : "Periodic refresh is disabled."
        if enabled {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }
}

struct CompanionView: View {
    @ObservedObject var model: CompanionModel
    @State private var showingFolderPicker = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                Text("Your companion, within iOS rules.")
                    .font(.title2.bold())
                Text("Miss Minutes can periodically inspect metadata in one folder you explicitly choose. It cannot float over other apps or run as an unrestricted background daemon.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Button("Choose folder") { showingFolderPicker = true }
                    .buttonStyle(.borderedProminent)
                Text(model.selectedFolder)
                    .font(.footnote)
                    .textSelection(.enabled)
                Toggle("Enable scheduled refresh", isOn: Binding(
                    get: { model.monitoringEnabled },
                    set: { model.setMonitoring($0) }
                ))
                Button {
                    model.refreshNow()
                } label: {
                    HStack {
                        if model.isRefreshing { ProgressView() }
                        Text("Refresh now")
                    }
                }
                .disabled(model.isRefreshing || !model.monitoringEnabled)
                Text(model.status)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding()
            .navigationTitle("Miss Minutes")
            .fileImporter(
                isPresented: $showingFolderPicker,
                allowedContentTypes: [.folder],
                allowsMultipleSelection: false
            ) { result in
                do {
                    let url = try result.get().first!
                    guard url.startAccessingSecurityScopedResource() else {
                        throw NSError(domain: "MissMinutes", code: 1, userInfo: [
                            NSLocalizedDescriptionKey: "iOS did not grant folder access."
                        ])
                    }
                    defer { url.stopAccessingSecurityScopedResource() }
                    let bookmark = try url.bookmarkData()
                    try MetadataRefresh.saveFolderBookmark(bookmark)
                    model.selectedFolder = url.lastPathComponent
                    model.status = "Folder access saved in Keychain."
                } catch {
                    model.status = error.localizedDescription
                }
            }
            .onAppear {
                if (try? KeychainStore.get("missMinutes.selectedFolderBookmark")) != nil {
                    model.selectedFolder = "A folder bookmark is saved on this device."
                }
            }
        }
    }
}
