use std::{path::PathBuf, process::Command};

fn main() {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    println!(
        "cargo:rerun-if-changed={}",
        workspace.join("proto").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        workspace.join("buf.yaml").display()
    );

    // `connectrpc_build::Config::use_buf` passes proto-relative names to `buf build --path`,
    // which buf v2 workspaces resolve from the workspace root instead, so buf runs here.
    let descriptors =
        PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("aperture.fds");
    let status = Command::new("buf")
        .current_dir(&workspace)
        .args(["build", "--as-file-descriptor-set", "-o"])
        .arg(&descriptors)
        .status()
        .expect("failed to run buf; it is provided by the nix dev shell");
    assert!(status.success(), "buf build failed");

    connectrpc_build::Config::new()
        .descriptor_set(&descriptors)
        .files(&[
            "aperture/executor/v1/executor.proto",
            "aperture/control/v1/nodes.proto",
        ])
        .include_file("_connectrpc.rs")
        .emit_rerun_directives(false)
        .compile()
        .expect("failed to generate protobuf code");
}
