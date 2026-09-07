# Synara Android keep rules.
#
# Parsing is reflection-free (org.json + explicit field reads) and the UI is static Compose, so
# almost nothing needs manual keeping: manifest-referenced components are kept by AGP
# automatically. Obfuscation is currently disabled in the release block; these rules exist so a
# future re-enable does not silently strip anything the wire protocol depends on.

# Never rename or remove anything in the data layer: class and property names here mirror the
# server's JSON contract, so a rename would survive compilation while breaking every parse.
-keep class com.synara.android.data.** { *; }

# Keep line numbers so production stack traces stay readable even once obfuscation returns.
-keepattributes SourceFile,LineNumberTable
