use kodax_windows_text_transaction::{TextTransactionErrorCode, validate_windows_target};

fn rejected(root: &str, target: &str) -> TextTransactionErrorCode {
    validate_windows_target(root, target).unwrap_err().code
}

#[test]
fn rejects_network_and_device_namespaces_before_filesystem_access() {
    assert_eq!(
        rejected(r"C:\work", r"\\server\share\file.txt"),
        TextTransactionErrorCode::InvalidPath,
    );
    assert_eq!(
        rejected(r"C:\work", r"\\?\C:\work\file.txt"),
        TextTransactionErrorCode::InvalidPath,
    );
    assert_eq!(
        rejected(r"C:\work", r"\\.\C:\work\file.txt"),
        TextTransactionErrorCode::InvalidPath,
    );
    assert_eq!(
        rejected(r"C:\work", r"\??\C:\work\file.txt"),
        TextTransactionErrorCode::InvalidPath,
    );
    assert_eq!(
        rejected(r"C:\work", r"\Device\HarddiskVolume1\work\file.txt"),
        TextTransactionErrorCode::InvalidPath,
    );
}

#[test]
fn rejects_ads_drive_relative_and_ambiguous_components() {
    for target in [
        r"C:relative.txt",
        r"C:\work\file.txt:secret",
        r"C:\work\file.txt::$DATA",
        "C:\\work\\trailing.\\file.txt",
        "C:\\work\\trailing \\file.txt",
        r"C:\work\CON",
        r"C:\work\aux.txt",
        r"C:\work\COM1.log",
        r"C:\work\GIT~1\config",
    ] {
        assert_eq!(
            rejected(r"C:\work", target),
            TextTransactionErrorCode::InvalidPath,
            "target should fail closed: {target}",
        );
    }
}

#[test]
fn rejects_components_that_cannot_fit_the_native_unicode_name() {
    let component = "x".repeat(256);
    let error = validate_windows_target(r"C:\workspace", &format!(r"C:\workspace\{component}"))
        .unwrap_err();
    assert_eq!(error.code, TextTransactionErrorCode::InvalidPath);
}

#[test]
fn accepts_an_ordinary_absolute_target_below_the_trusted_root() {
    let target = validate_windows_target(r"c:\WORK", r"C:/work/src/hello.md").unwrap();
    assert_eq!(target.relative_components, ["src", "hello.md"]);
    assert_eq!(target.normalized_relative, r"SRC\HELLO.MD");
}

#[test]
fn rejects_targets_outside_or_equal_to_the_trusted_root() {
    assert_eq!(
        rejected(r"C:\work", r"C:\other\file.txt"),
        TextTransactionErrorCode::UnauthorizedPath,
    );
    assert_eq!(
        rejected(r"C:\work", r"C:\work"),
        TextTransactionErrorCode::UnauthorizedPath,
    );
    assert_eq!(
        rejected(r"C:\work", r"D:\work\file.txt"),
        TextTransactionErrorCode::UnauthorizedPath,
    );
}
