package com.pantera.minibee_viewer

import com.google.android.play.agesignals.model.AgeSignalsErrorCode

// Store-build age gate. The GitHub sideload APK is InstallStore.Other and is
// never asked. Play is asked only when that API reports mandatory sharing.
// Amazon is asked on every Amazon install; an empty status means the law
// does not apply there (Amazon also uses empty for Kids+, which this 18+
// app is not part of). A band is adult only when its lower bound is at least
// 18 and its upper bound is absent or at least 18, so a custom top band that
// starts below 18 does not count. The numbers are not stored or forwarded.

internal enum class InstallStore { Play, Amazon, Other }

internal fun installStore(installerPackage: String?): InstallStore = when (installerPackage) {
  "com.android.vending" -> InstallStore.Play
  "com.amazon.venezia" -> InstallStore.Amazon
  else -> InstallStore.Other
}

internal enum class BlockReason {
  Underage,
  VerificationRequired,
  NotShared,
  Unconfirmed,
  ConsentNotGranted,
  StoreUnreachable,
}

internal sealed class AgeVerdict {
  data object Allow : AgeVerdict()
  data object Retry : AgeVerdict()
  data class Block(val reason: BlockReason) : AgeVerdict()
}

internal enum class PlayFailure { Allow, Retry, Block }

internal fun isRetryablePlayError(code: Int): Boolean =
  code == AgeSignalsErrorCode.INTERNAL_ERROR ||
    code in AgeSignalsErrorCode.CLIENT_TRANSIENT_ERROR..AgeSignalsErrorCode.API_NOT_AVAILABLE

// A Play install that cannot learn whether sharing is mandatory must not
// open: silence is not proof that no law applies. DEVICE_NOT_SUPPORTED is
// the exception Google documents as "use your default experience".
// APP_NOT_OWNED on a sideload (storeInstall false) is that same default;
// on a Play install it is a contradiction and stops.
internal fun playDiscoveryFailure(code: Int?, storeInstall: Boolean): PlayFailure = when {
  code == AgeSignalsErrorCode.DEVICE_NOT_SUPPORTED -> PlayFailure.Allow
  code == AgeSignalsErrorCode.APP_NOT_OWNED && !storeInstall -> PlayFailure.Allow
  code == AgeSignalsErrorCode.SDK_VERSION_OUTDATED -> PlayFailure.Block
  code != null && isRetryablePlayError(code) -> PlayFailure.Retry
  storeInstall -> PlayFailure.Block
  else -> PlayFailure.Allow
}

// Mandatory sharing is already known, so a failed read must not open.
internal fun playMandatoryFailure(code: Int?): PlayFailure = when {
  code != null && isRetryablePlayError(code) -> PlayFailure.Retry
  else -> PlayFailure.Block
}

internal fun adultBand(ageLower: Int?, ageUpper: Int?): Boolean =
  ageLower != null && ageLower >= 18 && (ageUpper == null || ageUpper >= 18)

internal fun sharedAgeVerdict(ageLower: Int?, ageUpper: Int?): AgeVerdict {
  if (ageLower == null) return AgeVerdict.Block(BlockReason.NotShared)
  if (adultBand(ageLower, ageUpper)) return AgeVerdict.Allow
  return AgeVerdict.Block(BlockReason.Underage)
}

internal fun amazonVerdict(
  responseStatus: String?,
  userStatus: String?,
  ageLower: Int?,
  ageUpper: Int?,
): AgeVerdict {
  // Null is a missing column or SQL NULL. Amazon documents a present empty
  // userStatus as "this law does not apply". A missing field is not that.
  if (responseStatus == null) return AgeVerdict.Retry
  when (responseStatus) {
    "SUCCESS" -> Unit
    "INTERNAL_TRANSIENT_ERROR" -> return AgeVerdict.Retry
    // Intentional compatibility fallback, not a finding that no age law
    // applies. Amazon uses this when the API is not enabled on the device
    // (legacy Fire OS). Same shape as Play's DEVICE_NOT_SUPPORTED, which
    // Google says should use the normal experience. Stopping here would
    // brick those devices.
    "FEATURE_NOT_SUPPORTED" -> return AgeVerdict.Allow
    // INTERNAL_ERROR, APP_NOT_OWNED, and anything unrecognised are failures,
    // not an empty userStatus. Empty is the only documented "law does not
    // apply" answer, and it arrives with SUCCESS.
    else -> return AgeVerdict.Block(BlockReason.StoreUnreachable)
  }
  if (userStatus == null) return AgeVerdict.Retry
  // Exact match. trim() would turn whitespace into the empty status, which
  // is the exemption. Whitespace is not that documented value.
  when (userStatus) {
    "" -> return AgeVerdict.Allow
    "VERIFIED" -> {
      // Amazon's adult row is ageLower 18 and ageUpper null. Anything else
      // is not that contract. A bound under 18 is underage; the rest is
      // unconfirmed, so a 19 with a missing upper bound is not told they
      // are under 18.
      if (ageLower == 18 && ageUpper == null) return AgeVerdict.Allow
      if (ageLower != null && ageLower < 18) return AgeVerdict.Block(BlockReason.Underage)
      if (ageUpper != null && ageUpper < 18) return AgeVerdict.Block(BlockReason.Underage)
      return AgeVerdict.Block(BlockReason.Unconfirmed)
    }
    "SUPERVISED" -> return AgeVerdict.Block(BlockReason.Underage)
    "CONSENT_NOT_GRANTED" -> return AgeVerdict.Block(BlockReason.ConsentNotGranted)
    "UNKNOWN" -> return AgeVerdict.Block(BlockReason.Unconfirmed)
    else -> return AgeVerdict.Block(BlockReason.Unconfirmed)
  }
}
