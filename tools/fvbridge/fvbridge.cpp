// fvbridge - reads fps / gpu / cpu / lat / foreground process from the installed
// NVIDIA FrameView SDK and prints one JSON object per second on stdout.
//
// Facts this relies on (from the fvsdk-spike record and FvSDK.h):
//  * frame summaries (AvgFPS, AvgSWPCLatency) are PER PROCESS, about 1/s, and
//    dwm.exe and iCUE.exe present frames continuously -> only the FOREGROUND
//    window's process is ever reported, and never those two.
//  * AvgSWPCLatency can be negative -> emitted as null.
//  * GPU / CPU utilisation arrive about every 0.5 s.
//
// FvSDK.h and FvSDK_x64.lib are taken from the installed SDK by build.ps1; no SDK
// file is copied into this repository. The static wrapper in the .lib loads
// FvSDK_x64.dll at runtime, see preloadSdkDll().

#include <windows.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "FvSDK.h"

namespace {

const wchar_t* kSdkDir = L"C:\\Program Files\\NVIDIA Corporation\\FrameViewSDK\\SDK\\Public_Release";
const double kStaleSeconds = 3.0;    // a sample not refreshed for this long is reported as null
const double kGraceSeconds = 4.0;    // first line waits this long for a gpu AND cpu sample
const int kPollMs = 250;
const int kEmitMs = 1000;

using Clock = std::chrono::steady_clock;

volatile bool g_stop = false;

BOOL WINAPI onCtrl(DWORD) {
    g_stop = true;
    return TRUE;
}

// The wrapper in FvSDK_x64.lib loads the DLL by name at FvSDK_Initialize(); the
// DLL exports only fv_QueryInterface, so there is no import to delay-load and no
// FvSDK_* export to GetProcAddress. Pre-loading it by full path (plus
// SetDllDirectoryW for its own dependencies) leaves a module of that name in the
// process, which is all the wrapper needs, without a copy beside the exe.
bool preloadSdkDll() {
    SetDllDirectoryW(kSdkDir);
    std::wstring full = std::wstring(kSdkDir) + L"\\FvSDK_x64.dll";
    return LoadLibraryExW(full.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH) != nullptr;
}

double ageSeconds(Clock::time_point since) {
    return std::chrono::duration<double>(Clock::now() - since).count();
}

std::string wideToUtf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

std::string jsonEscape(const std::string& s) {
    std::string o;
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
        else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
    return o;
}

bool equalsNoCase(const std::string& a, const char* b) {
    return _stricmp(a.c_str(), b) == 0;
}

// Processes that present frames continuously and are never a game. Never reported.
bool isExcludedProcess(const std::string& name) {
    return equalsNoCase(name, "dwm.exe") || equalsNoCase(name, "iCUE.exe");
}

// Two-call ReadData protocol: first call with mData == NULL yields the count,
// second fills a caller-supplied array of T. FvSDK.h documents the first call as
// returning FV_INSUFFICIENT_BUFFER; the installed SDK actually returns
// FV_MORE_DATA (0x2) with mNumSamples set (observed), so both are accepted.
template <class T>
bool readAll(FvSession s, FvMetricType type, std::vector<T>& out) {
    out.clear();
    Samples q;
    q.type = type;
    q.mData = nullptr;
    FvStatus first = FvSDK_ReadData(s, &q, 1);
    if ((first != FV_INSUFFICIENT_BUFFER && first != FV_MORE_DATA) || q.mNumSamples == 0) return false;
    out.assign(q.mNumSamples, T());
    q.mData = out.data();
    FvStatus st = FvSDK_ReadData(s, &q, 1);
    if (st != FV_SUCCESS && st != FV_MORE_DATA) { out.clear(); return false; }
    if (q.mNumSamples < out.size()) out.resize(q.mNumSamples);
    return !out.empty();
}

struct Held {
    double value = 0;
    unsigned long long sdkTs = 0;
    Clock::time_point seen{};
    bool valid = false;
    void set(double v, unsigned long long ts) { value = v; sdkTs = ts; seen = Clock::now(); valid = true; }
    bool fresh() const { return valid && ageSeconds(seen) <= kStaleSeconds; }
};

struct PerProcess {
    Held fps;
    Held lat;
};

std::string foregroundProcess(DWORD* pidOut, DWORD forcePid) {
    *pidOut = 0;
    DWORD pid = forcePid;
    if (!pid) {
        HWND h = GetForegroundWindow();
        if (!h) return std::string();
        GetWindowThreadProcessId(h, &pid);
    }
    *pidOut = pid;
    if (!pid) return std::string();
    HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!p) return std::string();
    wchar_t buf[MAX_PATH * 2];
    DWORD n = (DWORD)(sizeof buf / sizeof buf[0]);
    std::string name;
    if (QueryFullProcessImageNameW(p, 0, buf, &n)) {
        std::wstring w(buf, n);
        size_t slash = w.find_last_of(L"\\/");
        name = wideToUtf8(slash == std::wstring::npos ? w : w.substr(slash + 1));
    }
    CloseHandle(p);
    return name;
}

double clamp100(double v) {
    if (!(v >= 0)) return 0;
    return v > 100 ? 100 : v;
}

} // namespace

int main(int argc, char** argv) {
    // Test hooks, not used in production: --debug dumps raw per-process samples and
    // the foreground window to stderr; --pid N stands in for the foreground PID so
    // the frame path can be exercised without moving the user's focus.
    bool debug = false;
    DWORD forcePid = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--debug") == 0) debug = true;
        else if (strcmp(argv[i], "--pid") == 0 && i + 1 < argc) forcePid = (DWORD)strtoul(argv[++i], nullptr, 10);
    }
    SetConsoleCtrlHandler(onCtrl, TRUE);

    if (!preloadSdkDll()) {
        fprintf(stderr, "fvbridge: cannot load %ls\\FvSDK_x64.dll (error %lu)\n", kSdkDir, GetLastError());
        return 2;
    }
    if (FvSDK_Initialize() != FV_SUCCESS) {
        fprintf(stderr, "fvbridge: FvSDK_Initialize failed\n");
        return 2;
    }
    FvSession session = nullptr;
    if (FvSDK_CreateSession(&session) != FV_SUCCESS || !session) {
        fprintf(stderr, "fvbridge: FvSDK_CreateSession failed\n");
        FvSDK_Shutdown();
        return 2;
    }
    FvMetricType metrics[] = { eAvgFPS, eAvgSWPCLatency, eGPUUtil, eCPUUtil, eProcessName };
    FvStatus st = FvSDK_EnableMetrics(session, metrics, (unsigned int)(sizeof metrics / sizeof metrics[0]));
    if (st != FV_SUCCESS) fprintf(stderr, "fvbridge: FvSDK_EnableMetrics returned 0x%lx\n", (unsigned long)st);
    st = FvSDK_StartSession(session);
    // The installed SDK answers FV_SDK_SESSION_IN_PROGRESS (0x14) here while the
    // session is in fact collecting (observed: data flows afterwards), so it is
    // treated as success.
    if (st != FV_SUCCESS && st != FV_SDK_SESSION_IN_PROGRESS) {
        fprintf(stderr, "fvbridge: FvSDK_StartSession returned 0x%lx\n", (unsigned long)st);
        FvSDK_DestroySession(session);
        FvSDK_Shutdown();
        return 2;
    }

    std::map<unsigned long long, PerProcess> procs;     // by PID
    std::map<unsigned long long, std::string> sdkNames; // PID -> name as the SDK reports it
    std::map<size_t, Held> gpus;                        // by GPU index
    Held cpu;

    const auto startedAt = Clock::now();
    auto nextEmit = startedAt;
    bool emittedOnce = false;
    int exitCode = 0;

    while (!g_stop) {
        FvSDK_SampleData(session, FVSDK_SAMPLEDATA_DONOTWAIT);

        std::vector<AvgFPS> fpsS;
        if (readAll(session, eAvgFPS, fpsS))
            for (auto& s : fpsS) {
                procs[s.mFPS.PID].fps.set(s.mFPS.AvgFPS, s.mTimestamp);
                if (debug) fprintf(stderr, "fps pid=%llu v=%.3f ts=%llu\n", s.mFPS.PID, s.mFPS.AvgFPS, s.mTimestamp);
            }

        // For this metric the value is carried in mFPS.AvgFPS (the struct reuses FPS_v1).
        std::vector<AvgSWPCLatency> latS;
        if (readAll(session, eAvgSWPCLatency, latS))
            for (auto& s : latS) {
                procs[s.mFPS.PID].lat.set(s.mFPS.AvgFPS, s.mTimestamp);
                if (debug) fprintf(stderr, "lat pid=%llu v=%.3f ts=%llu\n", s.mFPS.PID, s.mFPS.AvgFPS, s.mTimestamp);
            }

        std::vector<GPUUtil> gpuS;
        if (readAll(session, eGPUUtil, gpuS))
            for (auto& s : gpuS) gpus[s.mGPUIndex].set(s.mGPUUtil, s.mTimestamp);

        std::vector<CPUUtil> cpuS;
        if (readAll(session, eCPUUtil, cpuS))
            for (auto& s : cpuS) cpu.set(s.mCPUUtil, s.mTimestamp);

        std::vector<ProcessName> nameS;
        if (readAll(session, eProcessName, nameS))
            for (auto& s : nameS) {
                size_t n = strnlen(s.name, FVSDK_PROCESS_NAME_SIZE);
                sdkNames[s.PID] = std::string(s.name, n);
                if (debug) fprintf(stderr, "name pid=%llu %s\n", s.PID, sdkNames[s.PID].c_str());
            }

        if (Clock::now() >= nextEmit) {
            double gpuV = -1;
            bool gpuOk = false;
            for (auto& kv : gpus)
                if (kv.second.fresh()) { gpuOk = true; if (kv.second.value > gpuV) gpuV = kv.second.value; }
            bool cpuOk = cpu.fresh();

            // Hold the first line until both gpu and cpu have a sample, up to the grace period.
            if (emittedOnce || (gpuOk && cpuOk) || ageSeconds(startedAt) >= kGraceSeconds) {
                DWORD fgPid = 0;
                std::string fgName = foregroundProcess(&fgPid, forcePid);
                if (fgName.empty() && fgPid) {
                    auto it = sdkNames.find(fgPid);
                    if (it != sdkNames.end()) fgName = it->second;
                }
                bool fgOk = fgPid != 0 && !fgName.empty() && !isExcludedProcess(fgName);
                if (debug) fprintf(stderr, "foreground pid=%lu name=%s excluded=%d\n", (unsigned long)fgPid, fgName.c_str(), fgPid != 0 && !fgName.empty() && isExcludedProcess(fgName));

                bool haveFps = false, haveLat = false;
                double fpsV = 0, latV = 0;
                unsigned long long tV = 0;
                if (fgOk) {
                    auto it = procs.find(fgPid);
                    if (it != procs.end() && it->second.fps.fresh()) {
                        haveFps = true;
                        fpsV = it->second.fps.value;
                        tV = it->second.fps.sdkTs;
                        const Held& l = it->second.lat;
                        // AvgSWPCLatency can be NEGATIVE (seen -10.78, -5.65, -0.135 ms): report null.
                        if (l.fresh() && l.value >= 0) { haveLat = true; latV = l.value; }
                    }
                }

                std::string line = "{";
                char b[96];
                if (haveFps && std::isfinite(fpsV)) { snprintf(b, sizeof b, "\"fps\":%.2f", fpsV); line += b; }
                else line += "\"fps\":null";
                if (gpuOk) { snprintf(b, sizeof b, ",\"gpu\":%.2f", clamp100(gpuV)); line += b; }
                else line += ",\"gpu\":null";
                if (cpuOk) { snprintf(b, sizeof b, ",\"cpu\":%.2f", clamp100(cpu.value)); line += b; }
                else line += ",\"cpu\":null";
                if (haveLat && std::isfinite(latV)) { snprintf(b, sizeof b, ",\"lat\":%.3f", latV); line += b; }
                else line += ",\"lat\":null";
                if (haveFps) line += ",\"process\":\"" + jsonEscape(fgName) + "\"";
                else line += ",\"process\":null";
                if (haveFps) { snprintf(b, sizeof b, ",\"t\":%llu", tV); line += b; }
                else line += ",\"t\":null";
                line += "}\n";

                if (fputs(line.c_str(), stdout) < 0 || fflush(stdout) != 0) { exitCode = 3; break; }
                // Only a printed line moves the schedule; while the first line is being
                // held, the gate is re-checked every poll so it goes out as soon as it can.
                nextEmit = emittedOnce ? nextEmit + std::chrono::milliseconds(kEmitMs)
                                : Clock::now() + std::chrono::milliseconds(kEmitMs);
                if (nextEmit < Clock::now()) nextEmit = Clock::now() + std::chrono::milliseconds(kEmitMs);
                emittedOnce = true;
            }
        }
        Sleep(kPollMs);
    }

    FvSDK_StopSession(session);
    FvSDK_DestroySession(session);
    FvSDK_Shutdown();
    return exitCode;
}
