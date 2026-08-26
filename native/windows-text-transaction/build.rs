fn main() {
    if std::env::var_os("CARGO_FEATURE_NODE_API").is_some() {
        napi_build::setup();
    }
}
