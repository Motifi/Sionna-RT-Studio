import AppKit
import WebKit

@MainActor
final class StudioApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
    WKDownloadDelegate, WKScriptMessageHandler {
    private let bundle = Bundle.main
    private let origin: URL
    private let smokeReport: URL?
    private let fileManager = FileManager.default
    private let session: URLSession
    private var window: NSWindow!
    private var webView: WKWebView!
    private var startup: NSStackView!
    private var startupLabel: NSTextField!
    private var server: Process?
    private var serverInput: FileHandle?
    private var logURL: URL?
    private var launchToken: String?
    private var chinese: Bool
    private var smokeStarted = false
    private var smokeResult: [String: Any]?
    private var smokeProject: URL?
    private var smokeCsi: URL?
    private var downloads: [ObjectIdentifier: (stage: URL, destination: URL)] = [:]

    override init() {
        let arguments = ProcessInfo.processInfo.arguments
        let environment = ProcessInfo.processInfo.environment
        let flag = arguments.firstIndex(of: "--smoke-report")
        let report = flag.flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        smokeReport = report.map { URL(fileURLWithPath: $0) }
        let testPort = report == nil ? nil : environment["SRTS_DESKTOP_TEST_PORT"].flatMap(UInt16.init)
        origin = URL(string: "http://127.0.0.1:\(testPort ?? 43110)")!
        chinese = report != nil || UserDefaults.standard.string(forKey: "studioLocale") != "en"
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 1
        config.connectionProxyDictionary = [:]
        session = URLSession(configuration: config)
        super.init()
    }

    private func text(_ english: String, _ simplifiedChinese: String) -> String {
        chinese ? simplifiedChinese : english
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = smokeReport == nil ? .default() : .nonPersistent()
        config.userContentController.add(self, name: "studioLocale")
        config.userContentController.addUserScript(WKUserScript(source: """
            const reportLocale = () => window.webkit.messageHandlers.studioLocale.postMessage(document.documentElement.lang);
            new MutationObserver(reportLocale).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
            reportLocale();
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false

        let visible = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1440, height: 900)
        let size = NSSize(width: min(1440, visible.width - 50), height: min(900, visible.height - 60))
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Sionna RT Studio"
        window.minSize = NSSize(width: 840, height: 580)
        window.center()

        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.startAnimation(nil)
        startupLabel = NSTextField(labelWithString: "")
        startup = NSStackView(views: [spinner, startupLabel])
        startup.orientation = .vertical
        startup.alignment = .centerX
        startup.spacing = 14
        startup.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.addSubview(webView)
        content.addSubview(startup)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            startup.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            startup.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])
        window.contentView = content
        updateMenus()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
        if let logURL { try? fileManager.removeItem(at: logURL) }
        if let smokeProject { try? fileManager.removeItem(at: smokeProject) }
        if let smokeCsi { try? fileManager.removeItem(at: smokeCsi) }
        for entry in downloads.values { try? fileManager.removeItem(at: entry.stage) }
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "studioLocale")
    }

    private func updateMenus() {
        let main = NSMenu()
        let applicationItem = main.addItem(withTitle: "Sionna RT Studio", action: nil, keyEquivalent: "")
        let application = NSMenu()
        application.addItem(withTitle: text("Quit Sionna RT Studio", "退出 Sionna RT Studio"),
                            action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = application

        let edit = NSMenu(title: text("Edit", "编辑"))
        edit.addItem(withTitle: text("Cut", "剪切"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: text("Copy", "复制"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: text("Paste", "粘贴"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: text("Select All", "全选"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(withTitle: edit.title, action: nil, keyEquivalent: "").submenu = edit

        let windows = NSMenu(title: text("Window", "窗口"))
        windows.addItem(withTitle: text("Minimize", "最小化"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: text("Close", "关闭"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        main.addItem(withTitle: windows.title, action: nil, keyEquivalent: "").submenu = windows
        NSApp.windowsMenu = windows
        NSApp.mainMenu = main
    }

    private func startServer() {
        webView.isHidden = true
        startup.isHidden = false
        startupLabel.stringValue = text("Starting Sionna RT…", "正在启动 Sionna RT…")
        guard let resources = bundle.resourceURL,
              let python = ProcessInfo.processInfo.environment["SRTS_PYTHON"]
                  ?? bundle.object(forInfoDictionaryKey: "StudioPythonPath") as? String,
              fileManager.isExecutableFile(atPath: python) else {
            startupFailed(text("The Studio Python environment is missing. Rebuild this app from the workspace.",
                               "找不到 Studio 的 Python 环境，请在工作区重新构建应用。"))
            return
        }

        if let logURL { try? fileManager.removeItem(at: logURL) }
        let log = fileManager.temporaryDirectory.appendingPathComponent("studio-\(UUID().uuidString).log")
        guard fileManager.createFile(atPath: log.path, contents: nil), let output = try? FileHandle(forWritingTo: log) else {
            startupFailed(text("Could not open the startup log.", "无法创建启动日志。"))
            return
        }
        logURL = log
        let token = UUID().uuidString
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = [resources.appendingPathComponent("studio_server.py").path, String(origin.port!)]
        process.currentDirectoryURL = resources
        var environment = ProcessInfo.processInfo.environment
        environment["SRTS_DESKTOP_LAUNCH_TOKEN"] = token
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        environment["PYTHONUNBUFFERED"] = "1"
        process.environment = environment
        let input = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = output
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.launchToken == token else { return }
                self.startupFailed(self.text("The ray-tracing service stopped.", "射线追踪服务已停止。"))
            }
        }
        do {
            try process.run()
        } catch {
            startupFailed(error.localizedDescription)
            return
        }
        server = process
        serverInput = input.fileHandleForWriting
        launchToken = token
        waitUntilReady(token: token, deadline: Date().addingTimeInterval(45))
    }

    private func waitUntilReady(token: String, deadline: Date) {
        guard launchToken == token else { return }
        guard Date() < deadline else {
            startupFailed(text("The ray-tracing service did not start in time.", "等待射线追踪服务启动超时。"))
            return
        }
        var request = URLRequest(url: origin.appendingPathComponent("_desktop-ready"))
        request.setValue(token, forHTTPHeaderField: "Studio-Token")
        session.dataTask(with: request) { [weak self] _, response, _ in
            let ready = (response as? HTTPURLResponse)?.statusCode == 204
            DispatchQueue.main.async {
                guard let self, self.launchToken == token else { return }
                if ready {
                    self.webView.load(URLRequest(url: self.origin, cachePolicy: .reloadIgnoringLocalCacheData))
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        self.waitUntilReady(token: token, deadline: deadline)
                    }
                }
            }
        }.resume()
    }

    private func stopServer() {
        launchToken = nil
        try? serverInput?.close()
        serverInput = nil
        if let server, server.isRunning { server.terminate() }
        server = nil
    }

    private func startupFailed(_ reason: String) {
        stopServer()
        var details = reason
        if let logURL, let log = try? FileHandle(forReadingFrom: logURL) {
            defer { try? log.close() }
            if let length = try? log.seekToEnd(), length > 0 {
                try? log.seek(toOffset: length > 3000 ? length - 3000 : 0)
                if let data = try? log.readToEnd(), let output = String(data: data, encoding: .utf8) {
                    details += "\n\n" + output
                }
            }
        }
        if smokeReport != nil {
            finishSmoke(["ok": false, "error": details])
            return
        }
        let alert = NSAlert()
        alert.messageText = text("Studio could not start", "实验台启动失败")
        alert.informativeText = details
        alert.addButton(withTitle: text("Retry", "重试"))
        alert.addButton(withTitle: text("Quit", "退出"))
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn { self.startServer() }
            else { NSApp.terminate(nil) }
        }
    }

    private func isLocal(_ url: URL) -> Bool {
        url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }

    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.absoluteString.hasPrefix("blob:\(origin.absoluteString)/") {
            decisionHandler(.download)
        } else if isLocal(url) {
            decisionHandler(action.shouldPerformDownload ? .download : .allow)
        } else {
            decisionHandler(.cancel)
            if action.navigationType == .linkActivated && url.scheme == "https" {
                NSWorkspace.shared.open(url)
            }
        }
    }

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        startup.isHidden = true
        webView.isHidden = false
        if smokeReport != nil && !smokeStarted { runSmoke() }
    }

    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard launchToken != nil, (error as NSError).code != NSURLErrorCancelled else { return }
        startupFailed(error.localizedDescription)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, isLocal(url),
              let lang = message.body as? String else { return }
        let next = lang.hasPrefix("zh")
        if next != chinese {
            chinese = next
            if smokeReport == nil { UserDefaults.standard.set(chinese ? "zh" : "en", forKey: "studioLocale") }
            updateMenus()
        }
    }

    func webView(_ view: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ view: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: text("OK", "确定"))
        alert.addButton(withTitle: text("Cancel", "取消"))
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ view: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: text("OK", "确定"))
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ view: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ view: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) {
        if let smokeDestination = suggestedFilename.lowercased().hasSuffix(".zip") ? smokeCsi : smokeProject {
            stageDownload(download, destination: smokeDestination, completionHandler: completionHandler)
            return
        }
        let panel = NSSavePanel()
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let destination = panel.url else { completionHandler(nil); return }
            self.stageDownload(download, destination: destination, completionHandler: completionHandler)
        }
    }

    private func stageDownload(_ download: WKDownload, destination: URL,
                               completionHandler: (URL?) -> Void) {
        let stage = destination.deletingLastPathComponent().appendingPathComponent(".studio-\(UUID().uuidString)")
        do {
            try fileManager.createDirectory(at: stage, withIntermediateDirectories: false)
            downloads[ObjectIdentifier(download)] = (stage, destination)
            completionHandler(stage.appendingPathComponent(destination.lastPathComponent))
        } catch {
            completionHandler(nil)
            showSaveError(error)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let entry = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        defer { try? fileManager.removeItem(at: entry.stage) }
        let source = entry.stage.appendingPathComponent(entry.destination.lastPathComponent)
        do {
            if fileManager.fileExists(atPath: entry.destination.path) {
                _ = try fileManager.replaceItemAt(entry.destination, withItemAt: source)
            } else {
                try fileManager.moveItem(at: source, to: entry.destination)
            }
            if (entry.destination == smokeProject || entry.destination == smokeCsi), var result = smokeResult {
                let data = try Data(contentsOf: entry.destination)
                if entry.destination == smokeCsi {
                    let exported = data.starts(with: [0x50, 0x4b, 0x03, 0x04]) &&
                        data.range(of: Data("csi.npz".utf8)) != nil && data.range(of: Data("manifest.json".utf8)) != nil
                    result["csiExport"] = exported
                } else {
                    let project = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                    result["projectExport"] = project?["format"] as? String == "SionnaRTStudio Project" &&
                        project?["schemaVersion"] as? Int == 2
                }
                smokeResult = result
                if let projectExport = result["projectExport"] as? Bool, let csiExport = result["csiExport"] as? Bool {
                    result["ok"] = result["ok"] as? Bool == true && projectExport && csiExport
                    finishSmoke(result)
                }
            }
        } catch {
            showSaveError(error)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let entry = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            try? fileManager.removeItem(at: entry.stage)
            showSaveError(error)
        }
    }

    private func showSaveError(_ error: Error) {
        if smokeReport != nil {
            finishSmoke(["ok": false, "error": error.localizedDescription])
            return
        }
        let alert = NSAlert()
        alert.messageText = text("Could not save file", "无法保存文件")
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: text("OK", "确定"))
        alert.beginSheetModal(for: window)
    }

    private func runSmoke() {
        smokeStarted = true
        let check = """
            async function waitFor(check, label = 'expected state') {
              for (let attempt = 0; attempt < 300; attempt++) {
                const result = check();
                if (result) return result;
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              throw new Error('Studio UI did not reach: ' + label);
            }
            const navFor = id => document.querySelector('#nav-btn-' + id);
            const go = async id => {
              navFor(id).click();
              await waitFor(() => navFor(id).getAttribute('aria-current') === 'page', id + ' workspace');
            };
            const project = () => JSON.parse(localStorage.getItem('sionna-rt-studio.project.v1'));
            const setNumber = async (selector, value) => {
              const input = await waitFor(() => document.querySelector(selector), selector);
              input.focus();
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
              input.dispatchEvent(new Event('input', {bubbles: true}));
              input.dispatchEvent(new Event('change', {bubbles: true}));
              await new Promise(resolve => setTimeout(resolve, 100));
              input.blur();
            };
            const select = await waitFor(() => document.querySelector('select[data-studio-language]'));
            const nav = await waitFor(() => navFor('scene'), 'Scene navigation');
            const initial = select.value;
            const alternate = initial === 'zh' ? 'en' : 'zh';
            const labels = {zh: '场景', en: 'Scene'};
            const waitForLanguage = language => waitFor(() =>
              document.documentElement.lang.startsWith(language) && nav.textContent.trim().endsWith(labels[language]));
            const setLanguage = value => {
              select.value = value;
              select.dispatchEvent(new Event('change', {bubbles: true}));
            };
            await waitForLanguage(initial);
            setLanguage(alternate);
            await waitForLanguage(alternate);
            setLanguage(initial);
            await waitForLanguage(initial);
            const canvas = await waitFor(() => {
              const scene = document.querySelector('#canvas-3d');
              return scene?.getContext('webgl2') && scene;
            }, '3D canvas');
            const starter = await waitFor(project, 'starter project');
            const legacy = structuredClone(starter);
            const oldRxId = legacy.state.devices.activeRxId;
            const anchor = legacy.state.scene.anchor;
            legacy.schemaVersion = 1;
            legacy.state.devices.transmitters[0].beamsteeringAzimuth = 37;
            legacy.state.devices.transmitters[0].beamsteeringElevation = -12;
            delete legacy.state.devices.fronthaulMbpsByTxId;
            delete legacy.state.csi;
            delete legacy.state.display.workspace;
            legacy.state.display.activeNavTab = '3d_scene';
            delete legacy.state.mobility.trajectoriesByRxId;
            legacy.state.mobility.trajectoryPoints = [0, 2].map(x => ({
              lat: anchor.latitude, lon: anchor.longitude, enu: {x, y: 0, z: 0},
            }));
            await go('export');
            const legacyInput = document.querySelector('#export-suite-panel input[type=file]');
            const transfer = new DataTransfer();
            transfer.items.add(new File([JSON.stringify(legacy)], 'legacy-project.json', {type: 'application/json'}));
            legacyInput.files = transfer.files;
            legacyInput.dispatchEvent(new Event('change', {bubbles: true}));
            await waitFor(() => navFor('planning').getAttribute('aria-current') === 'page' &&
              project()?.schemaVersion === 2 &&
              project().state.devices.transmitters[0].beamsteeringAzimuth === 37 &&
              project().state.devices.transmitters[0].beamsteeringElevation === -12 &&
              project().state.mobility.trajectoriesByRxId[oldRxId]?.length === 2 &&
              project().state.scene.buildings.length === starter.state.scene.buildings.length, 'legacy project migration');
            if (document.querySelector('#canvas-3d') !== canvas) throw new Error('Workspace change replaced the 3D canvas');
            const receivers = () => [...document.querySelectorAll('[data-device-type="rx"] [data-device-id]')];
            const savedDevices = () => project()?.state.devices;
            const clickScene = (x, y) => {
              const rect = canvas.getBoundingClientRect();
              canvas.dispatchEvent(new MouseEvent('click', {bubbles: true,
                clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y}));
            };
            const before = await waitFor(() => savedDevices()?.receivers.length > 0 && savedDevices(), 'initial receivers');
            const count = before.receivers.length;
            const add = document.querySelector('#btn-add-rx');
            add.click();
            await waitFor(() => add.getAttribute('aria-pressed') === 'true', 'receiver placement mode');
            clickScene(0.43, 0.56);
            await waitFor(() => receivers().length === count + 1, 'first new receiver');
            clickScene(0.65, 0.58);
            await waitFor(() => receivers().length === count + 2, 'second new receiver');
            document.querySelector('#btn-finish-placement').click();
            const placed = await waitFor(() => savedDevices()?.receivers.length === count + 2 && savedDevices(), 'saved receivers');
            const samePosition = (a, b) => a && b && Math.hypot(a.enu.x - b.enu.x, a.enu.y - b.enu.y, a.enu.z - b.enu.z) < 0.001;
            if (!before.receivers.every(rx => samePosition(rx, placed.receivers.find(item => item.id === rx.id)))) {
              throw new Error('Adding receivers moved an existing receiver');
            }
            const selected = receivers().find(button => button.dataset.deviceId === placed.receivers[count].id);
            selected.click();
            await waitFor(() => selected.getAttribute('aria-pressed') === 'true', 'receiver selected');
            const move = document.querySelector('#btn-move-rx');
            move.click();
            await waitFor(() => move.getAttribute('aria-pressed') === 'true', 'receiver move mode');
            clickScene(0.53, 0.72);
            await waitFor(() => move.getAttribute('aria-pressed') === 'false', 'receiver move completed');
            const moved = await waitFor(() => {
              const devices = savedDevices();
              return devices?.receivers.length === count + 2 &&
                !samePosition(placed.receivers[count], devices.receivers.find(rx => rx.id === selected.dataset.deviceId)) && devices;
            }, 'saved moved receiver');
            if (!placed.receivers.filter(rx => rx.id !== selected.dataset.deviceId)
                  .every(rx => samePosition(rx, moved.receivers.find(item => item.id === rx.id)))) {
              throw new Error('Moving the selected receiver moved another receiver');
            }
            add.click();
            await waitFor(() => add.getAttribute('aria-pressed') === 'true', 'placement before Escape');
            window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
            await waitFor(() => add.getAttribute('aria-pressed') === 'false', 'placement cancelled');
            clickScene(0.48, 0.68);
            await new Promise(resolve => setTimeout(resolve, 600));
            if (receivers().length !== count + 2 || savedDevices()?.receivers.length !== count + 2) {
              throw new Error('Cancelled placement added a receiver');
            }
            const transmitters = () => document.querySelectorAll('[data-device-type="tx"] [data-device-id]');
            const txCount = transmitters().length;
            const addTx = document.querySelector('#btn-add-tx');
            addTx.click();
            await waitFor(() => addTx.getAttribute('aria-pressed') === 'true', 'transmitter placement mode');
            clickScene(0.38, 0.66);
            await waitFor(() => transmitters().length === txCount + 1, 'new transmitter');
            document.querySelector('#btn-finish-placement').click();
            const apId = await waitFor(() => savedDevices()?.transmitters.length === txCount + 1 && savedDevices().activeTxId,
              'active AP');
            await setNumber('#input-ap-fronthaul', 25);
            await waitFor(() => savedDevices()?.fronthaulMbpsByTxId[apId] === 25, 'fronthaul 25 Mbps');

            await go('scene');
            const samples = document.querySelector('#select-path-samples');
            samples.value = '10000';
            samples.dispatchEvent(new Event('change', {bubbles: true}));
            await setNumber('#input-csi-subcarriers', 8);
            await waitFor(() => project()?.state.solver.options.pathSamplesPerSource === 10000 &&
              project()?.state.csi.numSubcarriers === 8, 'quick CSI sampling');

            const runRequests = [];
            const completedRuns = [];
            const originalFetch = window.fetch.bind(window);
            window.fetch = async (input, options) => {
              const isRun = new URL(input instanceof Request ? input.url : input, location.href).pathname === '/api/csi-runs';
              if (isRun) runRequests.push(JSON.parse(options.body));
              const response = await originalFetch(input, options);
              if (isRun && response.ok) completedRuns.push(await response.clone().json());
              return response;
            };
            const run = async mode => {
              const before = completedRuns.length;
              const button = await waitFor(() => {
                const button = document.querySelector('#btn-run-csi-' + mode);
                return button && !button.disabled && button;
              }, mode + ' CSI run button');
              button.click();
              return await waitFor(() => completedRuns.length > before && completedRuns[before], mode + ' CSI run');
            };
            const extractZip = async (result, fronthaulMbps) => {
              const response = await originalFetch('/api/csi-runs/' + result.runId + '/export', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({fronthaulMbpsByTxId: {[apId]: fronthaulMbps}}),
              });
              if (!response.ok) throw new Error('CSI export failed: ' + await response.text());
              const buffer = await response.arrayBuffer();
              const view = new DataView(buffer);
              const bytes = new Uint8Array(buffer);
              const decoder = new TextDecoder();
              const entries = new Map();
              for (let offset = 0; offset + 30 <= buffer.byteLength && view.getUint32(offset, true) === 0x04034b50;) {
                const length = view.getUint32(offset + 18, true);
                const nameLength = view.getUint16(offset + 26, true);
                const start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
                const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
                entries.set(name, bytes.subarray(start, start + length));
                offset = start + length;
              }
              const manifest = JSON.parse(decoder.decode(entries.get('manifest.json')));
              const npz = entries.get('csi.npz');
              if (!npz?.length || manifest.runId !== result.runId || manifest.fronthaulMbpsByTxId[apId] !== fronthaulMbps ||
                  JSON.stringify(manifest.shape) !== JSON.stringify(result.shape)) {
                throw new Error('CSI ZIP did not match the run or current fronthaul');
              }
              return {manifest, hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', npz))).join(',')};
            };

            await go('preview');
            const pairs = (txCount + 1) * (count + 2);
            const staticRun = await run('static');
            if (staticRun.shape[0] !== 1 || staticRun.shape[1] !== 3 || staticRun.shape[3] !== 2 || staticRun.shape[5] !== 8) {
              throw new Error('Unexpected static tensor shape ' + JSON.stringify(staticRun.shape));
            }
            const matrixButtons = () => [...document.querySelectorAll('#csi-link-matrix td button')];
            const otherPair = await waitFor(() => matrixButtons().length === pairs &&
              matrixButtons().find(button => button.getAttribute('aria-pressed') === 'false'), 'complete link matrix');
            otherPair.click();
            await waitFor(() => matrixButtons().length === pairs && otherPair.getAttribute('aria-pressed') === 'true',
              'matrix retained after selecting a different link');
            const beforeFronthaul = await extractZip(staticRun, 25);
            await go('planning');
            await setNumber('#input-ap-fronthaul', 0);
            await waitFor(() => savedDevices()?.fronthaulMbpsByTxId[apId] === 0, 'explicit zero fronthaul');
            await go('export');
            if (document.querySelector('#btn-export-csi-run').disabled) throw new Error('Fronthaul edit invalidated CSI');
            const afterFronthaul = await extractZip(staticRun, 0);
            if (runRequests.length !== 1 || beforeFronthaul.hash !== afterFronthaul.hash) {
              throw new Error('Export or fronthaul edit changed computed CSI');
            }
            await go('scene');
            await setNumber('#input-csi-subcarriers', 9);
            await waitFor(() => project()?.state.csi.numSubcarriers === 9, 'changed CSI input');
            await go('export');
            if (!document.querySelector('#btn-export-csi-run').disabled) throw new Error('Stale CSI remained exportable');

            await go('planning');
            const plannedRx = savedDevices().activeRxId;
            const draw = document.querySelector('#btn-draw-3d-mobility-path');
            draw.click();
            await waitFor(() => draw.getAttribute('aria-pressed') === 'true', 'draw mode');
            clickScene(0.42, 0.68);
            await waitFor(() => project()?.state.mobility.trajectoriesByRxId[plannedRx]?.length === 1, 'first control point');
            clickScene(0.62, 0.67);
            const track = await waitFor(() => {
              const points = project()?.state.mobility.trajectoriesByRxId[plannedRx];
              return points?.length === 2 && points;
            }, 'second control point');
            await go('preview');
            if (document.querySelector('#btn-draw-3d-mobility-path')) throw new Error('Draw controls remained visible in Preview');
            const trajectoryRun = await run('trajectory');
            const trajectorySamples = trajectoryRun.timeSeconds.length;
            if (trajectorySamples < 2 || trajectorySamples > 100 || trajectoryRun.shape[0] !== trajectorySamples ||
                trajectoryRun.shape[1] !== 1 || trajectoryRun.shape[3] !== 2 || trajectoryRun.shape[5] !== 9 ||
                trajectoryRun.rxIds[0] !== plannedRx || trajectoryRun.rxPositions.length !== trajectorySamples) {
              throw new Error('Unexpected trajectory result scope');
            }
            const timeline = await waitFor(() => document.querySelector('#input-csi-time'), 'CSI timeline');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(timeline, '1');
            timeline.dispatchEvent(new Event('input', {bubbles: true}));
            timeline.dispatchEvent(new Event('change', {bubbles: true}));
            await waitFor(() => document.querySelector('output[for=input-csi-time]')?.textContent ===
              trajectoryRun.timeSeconds[1].toFixed(3) + ' s', 'seek trajectory sample');
            const {manifest: motionManifest} = await extractZip(trajectoryRun, 0);
            if (JSON.stringify(motionManifest.timeSeconds) !== JSON.stringify(trajectoryRun.timeSeconds) ||
                JSON.stringify(motionManifest.rxPositions) !== JSON.stringify(trajectoryRun.rxPositions) ||
                JSON.stringify(track) !== JSON.stringify(project().state.mobility.trajectoriesByRxId[plannedRx])) {
              throw new Error('Exported times/positions or source control points changed');
            }
            if (runRequests.length !== 2 || document.querySelector('#canvas-3d') !== canvas) {
              throw new Error('Workspace navigation recomputed CSI or replaced the canvas');
            }
            const health = await (await fetch('/api/health')).json();
            const result = await fetch('/api/solve', {
              method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({
                tx: {id: 'smoke-tx', enu: {x: 0, y: 0, z: 0}, height: 2, antennaArraySize: [1, 1]},
                rx: {id: 'smoke-rx', enu: {x: 20, y: 0, z: 0}, height: 2, antennaArraySize: [1, 1]},
                buildings: [], freqGhz: 3.5, maxDepth: 0,
                options: {txPattern: 'iso', specularReflection: false, pathSamplesPerSource: 10000},
              }),
            });
            const solve = await result.json();
            if (!result.ok || solve.metrics?.losStatus !== 'LOS' || solve.metrics?.numPaths !== 1) {
              throw new Error('Studio LOS ray trace failed: ' + JSON.stringify(solve));
            }
            return {ok: health.ok === true, engine: health.engine, variant: health.variant,
                    webgl2: Boolean(canvas), initialLanguage: initial, alternateLanguage: alternate,
                    pageTitle: document.title, tracedPaths: solve.metrics.numPaths,
                    receivedPowerDbm: solve.metrics.totalRxPowerDbm, placedReceivers: count + 2,
                    movedSelectedReceiver: true, placementEscape: true, solvedMatrixPairs: pairs,
                    legacyProjectMigrated: true, staticCsiShape: staticRun.shape,
                    trajectoryCsiShape: trajectoryRun.shape, csiReusedWithFronthaul: true,
                    staleCsiBlocked: true, sameCanvasAcrossWorkspaces: true};
            """
        Task { [self] in
            do {
                let checked = try await webView.callAsyncJavaScript(check, arguments: [:], in: nil, contentWorld: .page)
                guard let checked = checked as? [String: Any] else {
                    finishSmoke(["ok": false, "error": "No WebKit smoke result"])
                    return
                }
                smokeResult = checked
                smokeProject = fileManager.temporaryDirectory.appendingPathComponent("studio-smoke-\(UUID().uuidString).json")
                smokeCsi = fileManager.temporaryDirectory.appendingPathComponent("studio-smoke-\(UUID().uuidString).zip")
                let export = """
                    document.querySelector('#nav-btn-export').click();
                    for (let attempt = 0; attempt < 40; attempt++) {
                      const project = document.querySelector('#btn-export-project');
                      const csi = document.querySelector('#btn-export-csi-run');
                      if (project && csi && !csi.disabled) { project.click(); csi.click(); return; }
                      await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    throw new Error('Project and CSI export buttons did not become available');
                    """
                _ = try await webView.callAsyncJavaScript(export, arguments: [:], in: nil, contentWorld: .page)
                DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
                    guard let self, self.smokeResult != nil else { return }
                    self.finishSmoke(["ok": false, "error": "Native project or CSI download did not finish"])
                }
            } catch {
                let detail = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String
                finishSmoke(["ok": false, "error": detail ?? error.localizedDescription])
            }
        }
    }

    private func finishSmoke(_ result: Any) {
        smokeResult = nil
        if let smokeReport, let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: smokeReport, options: .atomic)
        }
        NSApp.terminate(nil)
    }
}

@main
struct StudioMain {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let studio = StudioApp()
        app.setActivationPolicy(.regular)
        app.delegate = studio
        withExtendedLifetime(studio) { app.run() }
    }
}
