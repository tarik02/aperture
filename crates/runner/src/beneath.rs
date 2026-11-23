//! The session's files as they are reached from outside its sandbox. The browser writes
//! there, and what runs in its sandbox makes of the directory what it likes: a link in
//! place of a file or of a directory, a device, a pipe. A path followed from here would
//! lead wherever such a link points, with the reach of whoever runs the session and not
//! the sandbox's. So nothing below the files is reached by its path: a directory is held
//! open, and what is in it is opened from there with no link followed on the way and
//! nowhere but beneath it, which the kernel sees to (`openat2`).

use std::{
    ffi::OsString,
    fs::File,
    io,
    os::{fd::OwnedFd, unix::ffi::OsStringExt},
    path::Path,
    time::{Duration, SystemTime},
};

use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, ResolveFlags};

/// A directory of the session's files, held open.
pub struct Beneath(OwnedFd);

/// What is in a directory, as it is there and not as what it may point to.
pub struct Entry {
    pub name: String,
    pub kind: FileType,
    pub size: u64,
    pub modified: SystemTime,
}

/// Nowhere but beneath, and through no link, neither one of the files nor one of `/proc`.
const HELD: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_MAGICLINKS);

/// A name that is one part of a path, and so names what is in the directory itself.
fn plain(name: &str) -> io::Result<&str> {
    let one = !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\0']);
    one.then_some(name)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a file's name"))
}

impl Beneath {
    /// The session's files themselves: the one directory that is reached by its path, which
    /// nothing in the sandbox can put anything else in the place of.
    pub fn open(files: &Path) -> io::Result<Self> {
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
        Ok(Self(rustix::fs::open(files, flags, Mode::empty())?))
    }

    fn opened(&self, below: &Path, flags: OFlags, mode: Mode) -> io::Result<OwnedFd> {
        let flags = flags | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        Ok(rustix::fs::openat2(&self.0, below, flags, mode, HELD)?)
    }

    /// A directory below this one.
    pub fn directory(&self, below: &Path) -> io::Result<Self> {
        self.opened(below, OFlags::RDONLY | OFlags::DIRECTORY, Mode::empty())
            .map(Self)
    }

    /// The directory of that name in this one, made where there is none.
    pub fn directory_made(&self, name: &str) -> io::Result<Self> {
        match rustix::fs::mkdirat(&self.0, plain(name)?, Mode::from_raw_mode(0o755)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(err) => return Err(err.into()),
        }
        self.directory(Path::new(name))
    }

    /// A file below this directory, to read. Only a file is one: what is opened is asked
    /// what it is, and nothing waits for a pipe to be written to on the way.
    pub fn file(&self, below: &Path) -> io::Result<File> {
        let file = self.opened(below, OFlags::RDONLY | OFlags::NONBLOCK, Mode::empty())?;
        if FileType::from_raw_mode(rustix::fs::fstat(&file)?.st_mode) != FileType::RegularFile {
            return Err(io::Error::new(io::ErrorKind::NotFound, "not a file"));
        }
        Ok(File::from(file))
    }

    /// A new file of that name in this directory, to write, in place of whatever had the
    /// name: what was there is taken away and not written into.
    pub fn create(&self, name: &str) -> io::Result<File> {
        let name = plain(name)?;
        match rustix::fs::unlinkat(&self.0, name, AtFlags::empty()) {
            Ok(()) | Err(rustix::io::Errno::NOENT) => {}
            Err(err) => return Err(err.into()),
        }
        let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL;
        let mode = Mode::from_raw_mode(0o644);
        Ok(File::from(self.opened(Path::new(name), flags, mode)?))
    }

    /// Gives what is in this directory another name in it, in place of whatever had that.
    pub fn rename(&self, from: &str, to: &str) -> io::Result<()> {
        Ok(rustix::fs::renameat(
            &self.0,
            plain(from)?,
            &self.0,
            plain(to)?,
        )?)
    }

    /// Takes away what has that name in this directory, unless it is a directory: a link
    /// goes, and what it points to stays.
    pub fn remove(&self, name: &str) -> io::Result<()> {
        Ok(rustix::fs::unlinkat(
            &self.0,
            plain(name)?,
            AtFlags::empty(),
        )?)
    }

    /// What is in this directory, each as it is there.
    pub fn entries(&self) -> io::Result<Vec<Entry>> {
        let mut entries = Vec::new();
        for entry in Dir::read_from(&self.0)? {
            let entry = entry?;
            let name = entry.file_name();
            if matches!(name.to_bytes(), b"." | b"..") {
                continue;
            }
            let Ok(said) = OsString::from_vec(name.to_bytes().to_vec()).into_string() else {
                continue;
            };
            let stat = match rustix::fs::statat(&self.0, name, AtFlags::SYMLINK_NOFOLLOW) {
                Ok(stat) => stat,
                // Removed since it was listed.
                Err(rustix::io::Errno::NOENT) => continue,
                Err(err) => return Err(err.into()),
            };
            let seconds = Duration::new(stat.st_mtime.max(0) as u64, stat.st_mtime_nsec as u32);
            entries.push(Entry {
                name: said,
                kind: FileType::from_raw_mode(stat.st_mode),
                size: stat.st_size.max(0) as u64,
                modified: SystemTime::UNIX_EPOCH + seconds,
            });
        }
        Ok(entries)
    }
}
