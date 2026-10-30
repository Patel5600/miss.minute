import BackgroundTasks
import Foundation
import UserNotifications

struct MetadataSnapshot: Codable, Equatable {
    let relativePath: String
    let size: Int
    let modifiedAt: Date?
}

struct MetadataEvent: Codable, Identifiable {
    let id: UUID
    let kind: String
    let relativePath: String
    let observedAt: Date
}

enum MetadataRefresh {
    static let taskIdentifier = "com.patel5600.missminute.metadata-refresh"
    private static let enabledKey = "missMinutes.monitoringEnabled"
    private static let bookmarkKey = "missMinutes.selectedFolderBookmark"
    private static let maxFiles = 5_000
    private static let maxEvents = 5_000

    static func scheduleNext() {
        guard UserDefaults.standard.bool(forKey: enabledKey) else { return }
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            NSLog("[MissMinutes] Could not schedule background refresh: \(error)")
        }
    }

    static func handle(_ task: BGAppRefreshTask) {
        scheduleNext()
        let operation = Task {
            let success = await Task.detached(priority: .utility) {
                do {
                    try refreshMetadata()
                    return true
                } catch {
                    NSLog("[MissMinutes] Background metadata refresh failed: \(error)")
                    return false
                }
            }.value
            task.setTaskCompleted(success: success)
        }
        task.expirationHandler = {
            operation.cancel()
        }
    }

    static func refreshMetadata() throws {
        guard UserDefaults.standard.bool(forKey: enabledKey) else { return }
        guard let bookmark = try KeychainStore.get(bookmarkKey) else {
            throw NSError(domain: "MissMinutes.Metadata", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "No owner-approved folder bookmark is available."
            ])
        }
        var stale = false
        let root = try URL(
            resolvingBookmarkData: bookmark,
            options: [],
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        )
        guard !stale else {
            throw NSError(domain: "MissMinutes.Metadata", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "The folder permission bookmark is stale. Re-select the folder."
            ])
        }
        guard root.startAccessingSecurityScopedResource() else {
            throw NSError(domain: "MissMinutes.Metadata", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "The system did not grant access to the selected folder."
            ])
        }
        defer { root.stopAccessingSecurityScopedResource() }

        let keys: Set<URLResourceKey> = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else {
            throw NSError(domain: "MissMinutes.Metadata", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "The selected folder cannot be enumerated."
            ])
        }

        var current: [String: MetadataSnapshot] = [:]
        while let url = enumerator.nextObject() as? URL {
            if Task.isCancelled { throw CancellationError() }
            if current.count >= maxFiles { break }
            let values = try url.resourceValues(forKeys: keys)
            guard values.isRegularFile == true else { continue }
            let relative = String(url.path.dropFirst(root.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            current[relative] = MetadataSnapshot(
                relativePath: relative,
                size: values.fileSize ?? -1,
                modifiedAt: values.contentModificationDate
            )
        }

        let base = try supportDirectory()
        let snapshotURL = base.appendingPathComponent("metadata-snapshot.json")
        let eventsURL = base.appendingPathComponent("metadata-events.json")
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let previous = (try? Data(contentsOf: snapshotURL))
            .flatMap { try? decoder.decode([String: MetadataSnapshot].self, from: $0) } ?? [:]
        var events = (try? Data(contentsOf: eventsURL))
            .flatMap { try? decoder.decode([MetadataEvent].self, from: $0) } ?? []

        for (path, snapshot) in current {
            if previous[path] != snapshot {
                events.append(MetadataEvent(
                    id: UUID(),
                    kind: previous[path] == nil ? "document.discovered" : "document.metadata_changed",
                    relativePath: path,
                    observedAt: Date()
                ))
            }
        }
        if current.count == maxFiles {
            events.append(MetadataEvent(
                id: UUID(),
                kind: "coverage.limit_reached",
                relativePath: "",
                observedAt: Date()
            ))
        }

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let snapshotData = try encoder.encode(current)
        let eventData = try encoder.encode(Array(events.suffix(maxEvents)))
        try snapshotData.write(to: snapshotURL, options: .atomic)
        try eventData.write(to: eventsURL, options: .atomic)
        try protectFile(snapshotURL)
        try protectFile(eventsURL)

        let added = current.keys.filter { previous[$0] == nil }.count
        if added > 0 {
            let content = UNMutableNotificationContent()
            content.title = "Miss Minutes"
            content.body = "Your selected folder has \(added) newly observed file metadata entries."
            content.sound = .default
            let request = UNNotificationRequest(
                identifier: "metadata-\(UUID().uuidString)",
                content: content,
                trigger: nil
            )
            UNUserNotificationCenter.current().add(request)
        }
    }

    private static func supportDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: base.path
        )
        return base
    }

    private static func protectFile(_ url: URL) throws {
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: url.path
        )
    }

    static func setMonitoring(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: enabledKey)
        if enabled { scheduleNext() }
        else { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier) }
    }

    static func saveFolderBookmark(_ bookmark: Data) throws {
        try KeychainStore.set(bookmark, for: bookmarkKey)
    }
}
