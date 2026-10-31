package app.autoconfirm.parse

import org.json.JSONArray
import org.json.JSONObject

/**
 * Parser rules downloaded from the server (GET /device/v1/parser_rules), so a payment app's
 * wording change needs no app release. Format: docs/ANDROID-APP.md §4.2.
 */
data class IncomingPattern(
    val field: String, // title | text | big_text | any
    val regex: Regex,
    val amountGroup: Int,
    val payerGroup: Int?,
    val referenceGroup: Int?,
)

data class AppRules(
    val id: String,
    val packages: Set<String>,
    val incoming: List<IncomingPattern>,
    val ignore: List<Regex>,
)

data class ParserRules(val version: String, val apps: List<AppRules>) {
    fun forPackage(pkg: String): AppRules? = apps.firstOrNull { pkg in it.packages }

    companion object {
        /** Bad patterns are skipped instead of crashing, so one broken rule can't stop the others. */
        fun parse(json: String): ParserRules {
            val root = JSONObject(json)
            val apps = mutableListOf<AppRules>()
            val arr = root.optJSONArray("apps") ?: JSONArray()
            for (i in 0 until arr.length()) {
                val a = arr.optJSONObject(i) ?: continue
                val id = a.optString("id").takeIf { it.matches(Regex("^[a-z0-9_]{2,40}$")) } ?: continue
                val packages = strings(a.optJSONArray("packages")).toSet()
                val incoming = mutableListOf<IncomingPattern>()
                val inc = a.optJSONArray("incoming") ?: JSONArray()
                for (j in 0 until inc.length()) {
                    val p = inc.optJSONObject(j) ?: continue
                    val regex = compile(p.optString("regex")) ?: continue
                    val amount = p.optInt("amount", -1).takeIf { it >= 0 } ?: continue
                    incoming += IncomingPattern(
                        field = p.optString("field", "text"),
                        regex = regex,
                        amountGroup = amount,
                        payerGroup = if (p.has("payer")) p.optInt("payer") else null,
                        referenceGroup = if (p.has("reference")) p.optInt("reference") else null,
                    )
                }
                val ignore = strings(a.optJSONArray("ignore")).mapNotNull { compile(it) }
                if (packages.isNotEmpty()) apps += AppRules(id, packages, incoming, ignore)
            }
            return ParserRules(root.optString("version", ""), apps)
        }

        private fun strings(a: JSONArray?): List<String> =
            if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotEmpty() } }

        private fun compile(pattern: String): Regex? = try {
            if (pattern.isEmpty()) null else Regex(pattern)
        } catch (e: Exception) {
            null
        }
    }
}
