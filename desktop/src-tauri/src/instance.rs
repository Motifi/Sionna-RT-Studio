use std::{ffi::c_void, io, ptr};

const INSTANCE_NAME: &str = r"Local\SionnaRTStudio.Desktop";
const ERROR_ALREADY_EXISTS: u32 = 183;
const MB_ICONINFORMATION: u32 = 0x40;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateMutexW(attributes: *const c_void, initial_owner: i32, name: *const u16)
        -> *mut c_void;
    fn SetLastError(error: u32);
    fn GetLastError() -> u32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(window: *mut c_void, text: *const u16, caption: *const u16, flags: u32) -> i32;
}

pub struct InstanceGuard(ptr::NonNull<c_void>);

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        // The guard owns this handle and is the only caller that closes it.
        unsafe { CloseHandle(self.0.as_ptr()) };
    }
}

pub fn acquire() -> io::Result<Option<InstanceGuard>> {
    acquire_named(INSTANCE_NAME)
}

fn acquire_named(name: &str) -> io::Result<Option<InstanceGuard>> {
    let name = nul_terminated_utf16(name);
    // The name lives through the call, and null attributes make the handle non-inheritable.
    let (handle, error) = unsafe {
        SetLastError(0);
        let handle = CreateMutexW(ptr::null(), 0, name.as_ptr());
        (handle, GetLastError())
    };
    let handle =
        ptr::NonNull::new(handle).ok_or_else(|| io::Error::from_raw_os_error(error as i32))?;
    let guard = InstanceGuard(handle);
    // The named mutex exists while any process holds a handle, regardless of thread ownership.
    if error == ERROR_ALREADY_EXISTS {
        return Ok(None);
    }
    Ok(Some(guard))
}

pub fn show_startup_error(message: &str) {
    let text = nul_terminated_utf16(message);
    let title = nul_terminated_utf16("Sionna RT Studio");
    // Both strings live through the dialog, which can run before a window exists.
    unsafe {
        MessageBoxW(
            ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_ICONINFORMATION,
        )
    };
}

fn nul_terminated_utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::acquire_named;

    #[test]
    fn named_mutex_rejects_second_launch_until_guard_drops() {
        let name = format!(
            r"Local\SionnaRTStudio.Desktop.test.{}",
            uuid::Uuid::new_v4()
        );
        let first = acquire_named(&name).unwrap().unwrap();
        assert!(acquire_named(&name).unwrap().is_none());
        drop(first);
        assert!(acquire_named(&name).unwrap().is_some());
    }
}
