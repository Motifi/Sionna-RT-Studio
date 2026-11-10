using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SionnaRTStudio;

internal sealed class StudioWindow : Form
{
    private readonly string? acceptanceDirectory;
    private readonly string logPath;
    private readonly string profilePath;
    private readonly CancellationTokenSource lifetime = new();
    private readonly System.Windows.Forms.Timer monitor = new() { Interval = 250 };
    private readonly WebView2 webView = new() { Dock = DockStyle.Fill, Visible = false, AllowExternalDrop = false };
    private readonly Dictionary<CoreWebView2DownloadOperation, PendingDownload> downloads = new();
    private readonly Label startup = new()
    {
        Dock = DockStyle.Fill,
        Text = "Starting Sionna RT…\n正在启动 Sionna RT…",
        TextAlign = ContentAlignment.MiddleCenter,
    };

    private StudioBackend? backend;
    private Uri? origin;
    private bool closing;
    private bool saveDialogOpen;

    private sealed record PendingDownload(string Stage, string Destination, bool Overwrite);

    public StudioWindow(string? acceptanceDirectory)
    {
        this.acceptanceDirectory = acceptanceDirectory;
        var appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SionnaRTStudio");
        logPath = Path.Combine(acceptanceDirectory ?? Path.Combine(appData, "logs"), "studio.log");
        profilePath = Path.Combine(acceptanceDirectory ?? appData, "WebView2");

        Text = "Sionna RT Studio";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(840, 580);
        var screen = Screen.PrimaryScreen?.WorkingArea.Size ?? new Size(1440, 900);
        Size = new Size(Math.Min(1440, screen.Width - 30), Math.Min(900, screen.Height - 40));
        Controls.Add(webView);
        Controls.Add(startup);
        monitor.Tick += MonitorSession;
    }

    public int ResultCode { get; private set; }

    protected override async void OnShown(EventArgs args)
    {
        base.OnShown(args);
        try
        {
            backend = new StudioBackend(logPath, acceptanceDirectory);
            origin = await backend.StartAsync(lifetime.Token);
            await OpenWorkspaceAsync();
            startup.Hide();
            webView.Show();
            if (acceptanceDirectory is not null)
                await ReportReadinessAsync();
            if (!closing)
                monitor.Start();
        }
        catch (Exception error)
        {
            if (!closing)
                Fail(error);
        }
    }

    private async Task OpenWorkspaceAsync()
    {
        var token = lifetime.Token;
        var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: profilePath)
            .WaitAsync(TimeSpan.FromSeconds(30), token);
        await webView.EnsureCoreWebView2Async(environment).WaitAsync(TimeSpan.FromSeconds(30), token);
        var core = webView.CoreWebView2;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsWebMessageEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.NavigationStarting += (_, args) =>
        {
            if (IsLocalResource(args.Uri))
                return;
            args.Cancel = true;
            if (args.IsUserInitiated)
                OpenExternalLink(args.Uri);
        };
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            if (args.IsUserInitiated)
                OpenExternalLink(args.Uri);
        };
        core.DownloadStarting += SaveDownload;
        core.ProcessFailed += (_, args) =>
        {
            if (args.ProcessFailedKind is CoreWebView2ProcessFailedKind.BrowserProcessExited
                or CoreWebView2ProcessFailedKind.RenderProcessExited)
            {
                var failure = new InvalidOperationException($"WebView2 stopped ({args.ProcessFailedKind}).");
                BeginInvoke(() => Fail(failure));
            }
        };

        var navigation = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        void OnNavigationCompleted(object? _, CoreWebView2NavigationCompletedEventArgs args)
        {
            if (args.IsSuccess)
                navigation.TrySetResult();
            else
                navigation.TrySetException(new InvalidOperationException($"Studio navigation failed ({args.WebErrorStatus})."));
        }

        core.NavigationCompleted += OnNavigationCompleted;
        try
        {
            core.Navigate(origin!.AbsoluteUri);
            await navigation.Task.WaitAsync(TimeSpan.FromSeconds(30), token);
        }
        finally
        {
            if (!closing)
                core.NavigationCompleted -= OnNavigationCompleted;
        }
    }

    private async Task ReportReadinessAsync()
    {
        var core = webView.CoreWebView2;
        var token = lifetime.Token;
        var stopwatch = Stopwatch.StartNew();
        const string workspaceReady = """
            ['scene', 'planning', 'preview', 'export'].every(id => document.getElementById('nav-btn-' + id))
              && !!document.getElementById('canvas-3d')?.getContext('webgl2')
              && !!document.querySelector('[data-studio-language]')
            """;
        while (true)
        {
            if (await core.ExecuteScriptAsync(workspaceReady).WaitAsync(TimeSpan.FromSeconds(5), token) == "true")
                break;
            if (stopwatch.Elapsed > TimeSpan.FromSeconds(20))
                throw new InvalidOperationException("The Studio workspace did not render a WebGL2 canvas in WebView2.");
            await Task.Delay(200, token);
        }

        using var handler = new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) };
        await using var response = await client.GetStreamAsync(new Uri(origin!, "api/health"), token);
        using var health = await JsonDocument.ParseAsync(response, cancellationToken: token);
        WriteReport("desktop-ready.json", new
        {
            origin = origin!.AbsoluteUri,
            backendPid = backend!.ProcessId,
            uiReady = true,
            webgl2 = true,
            health = health.RootElement,
            webViewVersion = core.Environment.BrowserVersionString,
        });
    }

    private void MonitorSession(object? _, EventArgs args)
    {
        if (backend?.HasExited == true)
            Fail(new InvalidOperationException("The ray-tracing service stopped."));
        else if (acceptanceDirectory is not null && File.Exists(Path.Combine(acceptanceDirectory, "close")))
            Close();
    }

    private bool IsLocalResource(string address)
    {
        if (address.StartsWith("blob:", StringComparison.OrdinalIgnoreCase))
            address = address["blob:".Length..];
        return Uri.TryCreate(address, UriKind.Absolute, out var uri)
            && origin is not null && uri.Scheme == origin.Scheme && uri.Host == origin.Host && uri.Port == origin.Port;
    }

    private void OpenExternalLink(string address)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            return;
        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true })?.Dispose();
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            BeginInvoke(() => ShowError("Could not open the link.\n无法打开链接。", error));
        }
    }

    private async void SaveDownload(object? _, CoreWebView2DownloadStartingEventArgs args)
    {
        args.Handled = true;
        if (!IsLocalResource(args.DownloadOperation.Uri) || closing || saveDialogOpen)
        {
            args.Cancel = true;
            return;
        }

        saveDialogOpen = true;
        using var deferral = args.GetDeferral();
        // Opening a modal dialog inside the WebView2 callback is not supported.
        await Task.Yield();
        try
        {
            if (closing)
                return;
            var language = await webView.CoreWebView2.ExecuteScriptAsync("document.documentElement.lang");
            if (closing)
                return;
            var chinese = language != "\"en\"";
            var filename = Path.GetFileName(args.ResultFilePath);
            var extension = Path.GetExtension(filename);
            var allFiles = chinese ? "所有文件 (*.*)|*.*" : "All files (*.*)|*.*";
            using var save = new SaveFileDialog
            {
                Title = chinese ? "保存 Sionna RT Studio 导出文件" : "Save Sionna RT Studio export",
                FileName = filename,
                DefaultExt = extension.TrimStart('.'),
                Filter = extension.Length == 0 ? allFiles : $"{extension[1..].ToUpperInvariant()} (*{extension})|*{extension}|{allFiles}",
                OverwritePrompt = true,
                RestoreDirectory = true,
            };
            if (save.ShowDialog(this) != DialogResult.OK || closing)
            {
                args.Cancel = true;
                return;
            }

            // Stage beside the target so interruption never truncates an existing export.
            var stage = Path.Combine(Path.GetDirectoryName(save.FileName)!, $".studio-{Guid.NewGuid():N}.part");
            args.ResultFilePath = stage;
            var operation = args.DownloadOperation;
            downloads.Add(operation, new PendingDownload(stage, save.FileName, File.Exists(save.FileName)));
            operation.StateChanged += DownloadStateChanged;
        }
        catch (Exception error)
        {
            if (!closing)
            {
                args.Cancel = true;
                ShowError("Could not save the export.\n无法保存导出文件。", error);
            }
        }
        finally
        {
            saveDialogOpen = false;
        }
    }

    private void DownloadStateChanged(object? sender, object args)
    {
        if (sender is not CoreWebView2DownloadOperation operation
            || operation.State == CoreWebView2DownloadState.InProgress
            || !downloads.Remove(operation, out var download))
            return;

        operation.StateChanged -= DownloadStateChanged;
        if (operation.State == CoreWebView2DownloadState.Completed)
        {
            try
            {
                File.Move(download.Stage, download.Destination, overwrite: download.Overwrite);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                BeginInvoke(() => ShowError($"The export is saved at:\n导出文件已保存在：\n{download.Stage}", error));
            }
        }
        else
        {
            DeleteDownloadStage(download.Stage);
            if (operation.InterruptReason != CoreWebView2DownloadInterruptReason.UserCanceled)
            {
                var error = new IOException(operation.InterruptReason.ToString());
                BeginInvoke(() => ShowError("Export interrupted.\n导出中断。", error));
            }
        }
    }

    private static void DeleteDownloadStage(string stage)
    {
        try { File.Delete(stage); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        try { File.Delete(stage + ".crdownload"); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    private void WriteReport(string filename, object data)
    {
        var path = Path.Combine(acceptanceDirectory!, filename);
        File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(path + ".tmp", path, overwrite: true);
    }

    private void ShowError(string title, Exception error)
    {
        if (!closing)
            MessageBox.Show(this, $"{title}\n\n{error.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private void Fail(Exception error)
    {
        if (closing || ResultCode != 0)
            return;
        monitor.Stop();
        ResultCode = 1;
        if (acceptanceDirectory is not null)
            WriteReport("desktop-error.json", new { ok = false, error = error.ToString() });
        else
            ShowError($"Studio could not start or stopped.\nSionna RT Studio 启动失败或已停止。\n\nLog / 日志\n{logPath}", error);
        Close();
    }

    protected override void OnFormClosed(FormClosedEventArgs args)
    {
        closing = true;
        lifetime.Cancel();
        monitor.Dispose();
        foreach (var operation in downloads.Keys)
        {
            operation.StateChanged -= DownloadStateChanged;
            operation.Cancel();
        }
        webView.Dispose();
        foreach (var download in downloads.Values)
            DeleteDownloadStage(download.Stage);
        try
        {
            backend?.Dispose();
        }
        catch (Exception error)
        {
            var reportShutdownError = ResultCode == 0;
            ResultCode = 1;
            if (reportShutdownError)
            {
                if (acceptanceDirectory is not null)
                    WriteReport("desktop-error.json", new { ok = false, error = error.ToString() });
                else
                    MessageBox.Show($"Could not stop the ray-tracing service.\n无法关闭射线追踪服务。\n\n{error.Message}",
                        Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
        lifetime.Dispose();
        base.OnFormClosed(args);
    }
}
