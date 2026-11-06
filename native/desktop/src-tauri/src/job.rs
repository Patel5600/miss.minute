//! Ties the app's helper processes to its lifetime.
//!
//! At startup the app creates a Windows job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
//! but keeps its own process out of it. Each helper the app starts is assigned to the job
//! right after it spawns, through [`spawn_in_job`]. Windows ends every process still in the
//! job once the last handle to it closes, which happens when the app's process ends for any
//! reason, a crash or Task Manager kill included. The app holds the only handle and never
//! closes it, so the helpers live exactly as long as the app.
//!
//! Only the app's own helpers go in the job: the voice worker, a `run_command` PowerShell and
//! anything it starts, and later a local model server. Programs opened for the user (the
//! sign-in browser, files opened through the desktop tools) are launched normally and stay
//! out of the job, so closing Miss Minutes never ends them.

use std::process::{Child, Command};

/// Creates the job object. Call once at startup, before spawning any helper. Safe to call when
/// the platform has no job objects (then it does nothing).
pub fn init() -> Result<(), String> {
    platform::init()
}

/// Spawns `command` and, on Windows, puts the child in the job so it ends with the app. A child
/// that cannot be assigned still runs; the failure is logged, not fatal.
pub fn spawn_in_job(command: &mut Command) -> std::io::Result<Child> {
    let child = command.spawn()?;
    #[cfg(windows)]
    if let Err(error) = platform::assign(&child) {
        eprintln!("[desktop] A helper process is not tied to the app's lifetime: {error}");
    }
    Ok(child)
}

#[cfg(windows)]
mod platform {
    use std::{ffi::c_void, mem::size_of, os::windows::io::AsRawHandle, process::Child, sync::OnceLock};

    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::HANDLE,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        },
    };

    struct Job(HANDLE);

    // SAFETY: a kernel object handle may be used from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    /// Open for the life of the process; Windows closes it at exit, which ends the helpers.
    static JOB: OnceLock<Job> = OnceLock::new();

    pub fn init() -> Result<(), String> {
        if JOB.get().is_some() {
            return Ok(());
        }
        // SAFETY: plain Win32 calls; `limits` outlives the call that reads it.
        unsafe {
            let job = CreateJobObjectW(None, PCWSTR::null())
                .map_err(|error| format!("Cannot create a job object: {error}"))?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|error| format!("Cannot configure a job object: {error}"))?;
            let _ = JOB.set(Job(job));
        }
        Ok(())
    }

    pub fn assign(child: &Child) -> Result<(), String> {
        let job = JOB.get().ok_or("The job object was not created.")?;
        let handle = HANDLE(child.as_raw_handle() as *mut c_void);
        // SAFETY: `handle` is a live process handle owned by `child`; `job.0` is the job handle.
        unsafe {
            AssignProcessToJobObject(job.0, handle)
                .map_err(|error| format!("Cannot assign a process to the job object: {error}"))
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn init() -> Result<(), String> {
        Ok(())
    }
}
