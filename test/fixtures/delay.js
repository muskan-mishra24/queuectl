// Cross-platform stand-in for the unix `sleep` command, used only by the
// test suite so job commands work identically on Windows, macOS, and Linux.
setTimeout(() => {
  console.log('done');
}, 200);
