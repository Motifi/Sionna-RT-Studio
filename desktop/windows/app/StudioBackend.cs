using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace SionnaRTStudio;

internal sealed class StudioBackend : IDisposable
{
    private const int DesktopPort = 43110;
    private readonly string portFile;
    private readonly string logPath;
    private readonly bool ephemeralPort;
    private readonly string launchToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private readonly object logLock = new();
    private readonly StreamWriter log;
    private readonly Process process;
    private bool started;

    public StudioBackend(string logPath, string? acceptanceDirectory)
    {
        this.logPath = logPath;
        ephemeralPort = acceptanceDirectory is not null;
        portFile = acceptanceDirectory is null
            ? Path.Combine(Path.GetTempPath(), $"sionna-studio-{Guid.NewGuid():N}.port")
            : Path.Combine(acceptanceDirectory, "backend-port");
        var runtime = Path.Combine(AppContext.BaseDirectory, "runtime");
        var python = Path.Combine(runtime, "python", "python.exe");
        if (!File.Exists(python))
            python = Path.Combine(runtime, ".venv", "Scripts", "python.exe");
        if (!File.Exists(python))
            throw new FileNotFoundException("Extract the entire Studio ZIP into one folder and reopen Studio. "
                + "If building from source, rerun Install-Studio.ps1 to restore Python.", python);

        var start = new ProcessStartInfo(python)
        {
            WorkingDirectory = runtime,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        start.ArgumentList.Add("-m");
        start.ArgumentList.Add("desktop.studio_server");
        start.ArgumentList.Add((ephemeralPort ? 0 : DesktopPort).ToString(CultureInfo.InvariantCulture));
        start.Environment.Remove("PYTHONHOME");
        start.Environment.Remove("PYTHONPATH");
        start.Environment["PYTHONUTF8"] = "1";
        start.Environment["PYTHONNOUSERSITE"] = "1";
        start.Environment["PYTHONIOENCODING"] = "utf-8";
        start.Environment["PYTHONUNBUFFERED"] = "1";
        start.Environment["PYTHONDONTWRITEBYTECODE"] = "1";
        start.Environment["SRTS_DESKTOP_LAUNCH_TOKEN"] = launchToken;
        start.Environment["SRTS_DESKTOP_PORT_FILE"] = portFile;

        Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
        log = new StreamWriter(new FileStream(logPath, FileMode.Create, FileAccess.Write, FileShare.Read))
        {
            AutoFlush = true,
        };
        process = new Process { StartInfo = start };
        process.OutputDataReceived += (_, args) => WriteLog(args.Data);
        process.ErrorDataReceived += (_, args) => WriteLog(args.Data);
    }

    public int ProcessId => process.Id;
    public bool HasExited => started && process.HasExited;

    public async Task<Uri> StartAsync(CancellationToken cancellation)
    {
        started = process.Start();
        if (!started)
            throw new InvalidOperationException("Could not launch the Studio Python environment.");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var handler = new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(2) };
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < TimeSpan.FromSeconds(90))
        {
            cancellation.ThrowIfCancellationRequested();
            if (HasExited)
            {
                process.WaitForExit(); // Drain captured startup errors before displaying them.
                throw new InvalidOperationException($"The ray-tracing service exited with code {process.ExitCode}.{StartupDiagnostics()}");
            }
            var origin = GetOrigin();
            if (origin is not null)
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(origin, "_desktop-ready"));
                request.Headers.Add("Studio-Token", launchToken);
                try
                {
                    using var response = await client.SendAsync(request, cancellation);
                    if (response.StatusCode == HttpStatusCode.NoContent)
                        return origin;
                }
                catch (HttpRequestException)
                {
                    // The server has not bound the loopback listener yet.
                }
                catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
                {
                    // A readiness probe timed out while the service was starting.
                }
            }
            await Task.Delay(250, cancellation);
        }
        throw new TimeoutException($"The ray-tracing service did not become ready within 90 seconds.{StartupDiagnostics()}");
    }

    private string StartupDiagnostics()
    {
        try
        {
            using var file = new FileStream(logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            file.Seek(Math.Max(0, file.Length - 3000), SeekOrigin.Begin);
            using var reader = new StreamReader(file, Encoding.UTF8);
            var details = reader.ReadToEnd().Trim();
            if (details.Contains("ModuleNotFoundError", StringComparison.Ordinal))
                details += "\n\nExtract the full Studio ZIP again, or rerun Install-Studio.ps1 for a source installation.";
            return string.IsNullOrWhiteSpace(details) ? "" : $"\n\n{details}";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return "";
        }
    }

    private Uri? GetOrigin()
    {
        // Wait for our process to bind the socket before sending it a token.
        if (!File.Exists(portFile) || !int.TryParse(File.ReadAllText(portFile), out var port)
            || port is < 1 or > 65535 || (!ephemeralPort && port != DesktopPort))
            return null;
        return new Uri($"http://127.0.0.1:{port}/");
    }

    private void WriteLog(string? line)
    {
        if (line is null)
            return;
        lock (logLock)
        {
            try { log.WriteLine(line); }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        }
    }

    public void Dispose()
    {
        try
        {
            if (started)
            {
                process.StandardInput.Close();
                if (!process.WaitForExit(6500))
                {
                    process.Kill(entireProcessTree: true);
                    if (!process.WaitForExit(2000))
                        throw new InvalidOperationException("The ray-tracing service did not stop.");
                    throw new TimeoutException("The ray-tracing service had to be stopped after its shutdown deadline.");
                }
                // Wait for stdout/stderr callbacks to finish before closing the log.
                process.WaitForExit();
            }
        }
        finally
        {
            process.Dispose();
            lock (logLock)
                log.Dispose();
            if (!ephemeralPort)
            {
                try { File.Delete(portFile); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
    }
}
