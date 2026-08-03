// Stand-in CLI entry for background-spawn tests: process.argv[1] is swapped to this file so
// the detached child is a harmless no-op instead of whatever binary is actually running the
// test suite (spawning vitest detached with relay args would start a second test run).
process.exit(0);
