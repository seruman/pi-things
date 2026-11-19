// Runs before any test file imports Pi, which picks its env var names (PI_ or PIW_) at import time.
// Tests started from inside a Pi or Rex session must not see that session's identity or agent directory.
const keep = new Set(["PI_TEST_EXECUTABLE", "PI_TELEMETRY", "PI_SKIP_VERSION_CHECK", "PI_OFFLINE"])

for (const key of Object.keys(process.env)) {
	if (/^(PI|PIW|REX)_/.test(key) && !keep.has(key)) Reflect.deleteProperty(process.env, key)
}
