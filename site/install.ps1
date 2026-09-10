# siteio Windows installer
#
# Windows is NOT supported. GitHub releases do not build a Windows binary
# (see .github/workflows/release.yml — windows-x64 is commented out).
#
# Use macOS or Linux instead:
#   curl -LsSf https://siteio.houlahop.com/install | sh

Write-Error "siteio does not ship a Windows binary yet. Install on macOS or Linux: curl -LsSf https://siteio.houlahop.com/install | sh"
exit 1
