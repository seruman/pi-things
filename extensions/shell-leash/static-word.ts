export type StaticWordPart =
	| { readonly kind: "literal"; readonly value: string }
	| { readonly kind: "parameter"; readonly source: string }
	| { readonly kind: "command-substitution"; readonly source: string }
	| { readonly kind: "arithmetic"; readonly source: string }
	| { readonly kind: "glob"; readonly source: string }
	| { readonly kind: "other-dynamic"; readonly source: string }

export type StaticWord =
	| { readonly kind: "literal"; readonly value: string }
	| {
			readonly kind: "composite"
			readonly source: string
			readonly parts: readonly StaticWordPart[]
			readonly knownPrefix: string
			readonly knownSuffix: string
	  }
