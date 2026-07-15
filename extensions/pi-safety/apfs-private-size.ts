import { FFIType, dlopen, ptr } from "bun:ffi"
import { type Result, err, ok } from "./result"

const ATTR_BIT_MAP_COUNT = 5
const ATTR_CMNEXT_PRIVATESIZE = 0x00000008
const FSOPT_NOFOLLOW = 0x00000001
const FSOPT_ATTR_CMN_EXTENDED = 0x00000020
const ATTRIBUTE_LIST_SIZE = 24
const RESULT_SIZE = 12

const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
	getattrlist: {
		args: [FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64],
		returns: FFIType.i32,
	},
})

export type ApfsPrivateSizeError = {
	readonly kind: "private-size-unavailable"
	readonly path: string
}

export function readApfsPrivateSize(path: string): Result<bigint, ApfsPrivateSizeError> {
	const attributes = Buffer.alloc(ATTRIBUTE_LIST_SIZE)
	attributes.writeUInt16LE(ATTR_BIT_MAP_COUNT, 0)
	attributes.writeUInt32LE(ATTR_CMNEXT_PRIVATESIZE, 20)
	const output = Buffer.alloc(RESULT_SIZE)
	const pathname = Buffer.from(`${path}\0`)
	const status = libSystem.symbols.getattrlist(
		ptr(pathname),
		ptr(attributes),
		ptr(output),
		output.length,
		FSOPT_NOFOLLOW | FSOPT_ATTR_CMN_EXTENDED,
	)
	if (status !== 0 || output.readUInt32LE(0) !== RESULT_SIZE) {
		return err({ kind: "private-size-unavailable", path })
	}
	const size = output.readBigInt64LE(4)
	return size >= 0n ? ok(size) : err({ kind: "private-size-unavailable", path })
}
