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

// Discovery has not established that a law applies. A missing Play Store
// answer is not an under-18 band. An outdated SDK is our bug to stop on.
internal fun playDiscoveryFailure(code: Int?): PlayFailure = when {
  code == null -> PlayFailure.Allow
  code == AgeSignalsErrorCode.APP_NOT_OWNED -> PlayFailure.Allow
  code == AgeSignalsErrorCode.DEVICE_NOT_SUPPORTED -> PlayFailure.Allow
  code == AgeSignalsErrorCode.SDK_VERSION_OUTDATED -> PlayFailure.Block
  isRetryablePlayError(code) -> PlayFailure.Retry
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
  responseStatus: String,
  userStatus: String,
  ageLower: Int?,
  ageUpper: Int?,
): AgeVerdict {
  when (responseStatus) {
    "SUCCESS" -> Unit
    "INTERNAL_TRANSIENT_ERROR" -> return AgeVerdict.Retry
    else -> return AgeVerdict.Allow
  }
  when (userStatus.trim()) {
    "" -> return AgeVerdict.Allow
    "VERIFIED" -> {
      // VERIFIED means 18+ when the bounds are absent. Bounds that say
      // otherwise are not treated as an adult.
      if (ageLower != null && !adultBand(ageLower, ageUpper)) {
        return AgeVerdict.Block(BlockReason.Underage)
      }
      if (ageUpper != null && ageUpper < 18) return AgeVerdict.Block(BlockReason.Underage)
      return AgeVerdict.Allow
    }
    "SUPERVISED" -> return AgeVerdict.Block(BlockReason.Underage)
    "CONSENT_NOT_GRANTED" -> return AgeVerdict.Block(BlockReason.ConsentNotGranted)
    "UNKNOWN" -> return AgeVerdict.Block(BlockReason.Unconfirmed)
    else -> return AgeVerdict.Block(BlockReason.Unconfirmed)
  }
}
