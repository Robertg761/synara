package com.synara.android.data

import org.json.JSONObject

/** Per-provider server settings, flattened to the fields every provider shares. */
data class ProviderSettings(
    val provider: Provider,
    val enabled: Boolean,
    val binaryPath: String?,
) {
    companion object {
        fun fromJson(provider: Provider, json: JSONObject?) = ProviderSettings(
            provider = provider,
            // Absent means enabled: the server's defaults leave providers on, and treating a
            // missing key as "off" would show every unconfigured provider as disabled.
            enabled = json?.optBoolean("enabled", true) ?: true,
            binaryPath = json?.stringOrNull("binaryPath"),
        )
    }
}

/** `ServerSettings`, reduced to what a phone can meaningfully show and change. */
data class ServerSettings(
    val enableAssistantStreaming: Boolean,
    val enableProviderUpdateChecks: Boolean,
    val defaultThreadEnvMode: String,
    val addProjectBaseDirectory: String,
    val providers: List<ProviderSettings>,
) {
    companion object {
        fun fromJson(json: JSONObject): ServerSettings {
            val providers = json.objectOrNull("providers")
            return ServerSettings(
                enableAssistantStreaming = json.optBoolean("enableAssistantStreaming", true),
                enableProviderUpdateChecks = json.optBoolean("enableProviderUpdateChecks", true),
                defaultThreadEnvMode = json.stringOrNull("defaultThreadEnvMode") ?: "local",
                addProjectBaseDirectory = json.stringOrNull("addProjectBaseDirectory").orEmpty(),
                providers = Provider.entries.map {
                    ProviderSettings.fromJson(it, providers?.objectOrNull(it.kind))
                },
            )
        }
    }
}

/** Live availability and auth state for one provider binary. */
data class ProviderStatus(
    val provider: Provider,
    val status: String,
    val available: Boolean,
    val authStatus: String,
    val authLabel: String?,
    val version: String?,
    val message: String?,
    val updateAvailable: Boolean,
) {
    companion object {
        fun fromJson(json: JSONObject): ProviderStatus? {
            val provider = Provider.fromKind(json.stringOrNull("provider").orEmpty()) ?: return null
            val advisory = json.objectOrNull("versionAdvisory")
            return ProviderStatus(
                provider = provider,
                status = json.stringOrNull("status") ?: "unknown",
                available = json.optBoolean("available", false),
                authStatus = json.stringOrNull("authStatus") ?: "unknown",
                authLabel = json.stringOrNull("authLabel"),
                version = json.stringOrNull("version"),
                message = json.stringOrNull("message"),
                updateAvailable = advisory?.stringOrNull("status") == "behind_latest",
            )
        }
    }
}

data class UsageLimit(
    val window: String,
    val usedPercent: Double?,
    val resetsAt: String?,
) {
    companion object {
        fun fromJson(json: JSONObject) = UsageLimit(
            window = json.stringOrNull("window") ?: "",
            usedPercent = if (json.has("usedPercent") && !json.isNull("usedPercent")) {
                json.optDouble("usedPercent")
            } else {
                null
            },
            resetsAt = json.stringOrNull("resetsAt"),
        )
    }
}

data class UsageLine(val label: String, val value: String, val subtitle: String?) {
    companion object {
        fun fromJson(json: JSONObject) = UsageLine(
            label = json.stringOrNull("label") ?: "",
            value = json.stringOrNull("value") ?: "",
            subtitle = json.stringOrNull("subtitle"),
        )
    }
}

/**
 * One provider's usage. `status` distinguishes "no usage to show" from "could not fetch", which
 * matters: an unauthenticated provider and a broken fetch look identical without it.
 */
data class ProviderUsage(
    val provider: Provider,
    val status: String,
    val planName: String?,
    val detail: String?,
    val limits: List<UsageLimit>,
    val lines: List<UsageLine>,
) {
    val isOk: Boolean get() = status == "ok"

    companion object {
        fun fromJson(json: JSONObject): ProviderUsage? {
            val provider = Provider.fromKind(json.stringOrNull("provider").orEmpty()) ?: return null
            return ProviderUsage(
                provider = provider,
                status = json.stringOrNull("status") ?: "ok",
                planName = json.stringOrNull("planName"),
                detail = json.stringOrNull("detail"),
                limits = json.arrayOrEmpty("limits").objects().map(UsageLimit::fromJson),
                lines = json.arrayOrEmpty("usageLines").objects().map(UsageLine::fromJson),
            )
        }
    }
}
