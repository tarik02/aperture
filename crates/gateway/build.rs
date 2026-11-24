//! Takes the workbench, the page that shows a session, into the program: one HTML file
//! with everything it needs in it, which `apps/workbench` builds. `APERTURE_WORKBENCH`
//! names another one. Without either the program is built with a page that says so, so
//! that building it never takes the frontend's tools.

use std::{env, fs, path::PathBuf};

const MISSING: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>Aperture</title>
<body style="font: 16px system-ui; margin: 3rem; max-width: 40rem">
<h1 style="font-size: 1.25rem">The workbench is not in this program</h1>
<p>The session is running, and its other routes answer. This program was built without
the page that shows it: build <code>apps/workbench</code> and then the program again.</p>
"#;

fn main() {
    println!("cargo:rerun-if-env-changed=APERTURE_WORKBENCH");
    let built = match env::var_os("APERTURE_WORKBENCH") {
        Some(given) => PathBuf::from(given),
        None => PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("set by cargo"))
            .join("../../apps/workbench/dist/index.html"),
    };
    println!("cargo:rerun-if-changed={}", built.display());
    let page = fs::read_to_string(&built).unwrap_or_else(|_| MISSING.to_owned());
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("set by cargo")).join("workbench.html");
    fs::write(out, page).expect("the build's own directory takes files");
}
