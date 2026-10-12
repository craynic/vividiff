$ErrorActionPreference = 'Stop'
function Assert-Exit([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}
npm.cmd ci
Assert-Exit 'npm ci'
npm.cmd test
Assert-Exit 'frontend tests'
npm.cmd run build
Assert-Exit 'frontend build'
cargo fmt --all -- --check
Assert-Exit 'Rust formatting'
cargo test -p vividiff-core
Assert-Exit 'Rust tests'
cargo clippy -p vividiff-core --all-targets -- -D warnings
Assert-Exit 'Clippy'
npm.cmd run test:e2e
Assert-Exit 'browser end-to-end tests'
Write-Output 'All automated development checks passed. Build and native smoke-test the installer separately.'
