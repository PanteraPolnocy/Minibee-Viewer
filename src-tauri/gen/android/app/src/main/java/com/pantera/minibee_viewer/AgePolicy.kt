package com.pantera.minibee_viewer

import com.google.android.play.agesignals.model.AgeSignalsErrorCode

// Store-build age gate. A store is asked only when that store installed the
// app, which is the AAB that Play and Amazon ship; the GitHub sideload APK is
// InstallStore.Other and is never asked. Play is asked only when that API
// reports mandatory sharing: its terms allow the age data only for complying
// with a law, and that is where one applies. Amazon is asked on every Amazon
// install; an empty status means the law does not apply there (Amazon also
// uses empty for Kids+, which this 18+ app is not part of). A band is adult
// only when its lower bound is at least 18 and its upper bound is absent or
// at least 18, so a custom top band that starts below 18 does not count (Play
// Console's custom age ranges, if used, need 18 among their minimum ages, or
// adults read as unconfirmed). The numbers are not stored or forwarded.

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
  PlayNeedsUpdate,
  AppNeedsUpdate,
  StoreUnreachable,
}

internal sealed class AgeVerdict {
  data object Allow : AgeVerdict()
  data object Retry : AgeVerdict()
  data class Block(val reason: BlockReason) : AgeVerdict()
}

internal enum class PlayFailure { Allow, Retry, Block }

// Google's "Retryable" column: every code from API_NOT_AVAILABLE (-1) down to
// CLIENT_TRANSIENT_ERROR (-8). INTERNAL_ERROR is marked no, but its advice is
// a retry strategy with a maximum number of attempts, so it gets the same
// bounded retries.
internal fun isRetryablePlayError(code: Int): Boolean =
  code == AgeSignalsErrorCode.INTERNAL_ERROR ||
    code in AgeSignalsErrorCode.CLIENT_TRANSIENT_ERROR..AgeSignalsErrorCode.API_NOT_AVAILABLE

// A Play install that cannot learn whether sharing is mandatory must not
// open: silence is not proof that no law applies. That holds for a Play
// Store too old to be asked as well: the question exists from Play Store
// 54.1 on, and the library refuses an older one itself, before any call, in
// every country (PLAY_STORE_VERSION_OUTDATED). The screen then asks for the
// store to be updated. Kept that way on purpose.
//
// DEVICE_NOT_SUPPORTED is the one exception. Google says only that the API
// does not support this kind of device and offers no step that would change
// it, so there is no age signal to wait for, the same case as Amazon's
// FEATURE_NOT_SUPPORTED. APP_NOT_OWNED on a sideload (storeInstall false) is a
// debug build outside Play and opens; on a Play install it is a contradiction
// and stops.
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

// What the screen asks of the user once Play has failed for good, after
// Google's advice for each code: update or turn on the Play Store and Play
// services (an old or missing store app, a service it cannot bind to), update
// this app (an age SDK Play no longer accepts), or try again later.
internal fun playBlockReason(code: Int?): BlockReason = when (code) {
  AgeSignalsErrorCode.API_NOT_AVAILABLE,
  AgeSignalsErrorCode.PLAY_STORE_NOT_FOUND,
  AgeSignalsErrorCode.PLAY_SERVICES_NOT_FOUND,
  AgeSignalsErrorCode.CANNOT_BIND_TO_SERVICE,
  AgeSignalsErrorCode.PLAY_STORE_VERSION_OUTDATED,
  AgeSignalsErrorCode.PLAY_SERVICES_VERSION_OUTDATED -> BlockReason.PlayNeedsUpdate
  AgeSignalsErrorCode.SDK_VERSION_OUTDATED -> BlockReason.AppNeedsUpdate
  else -> BlockReason.StoreUnreachable
}

internal fun adultBand(ageLower: Int?, ageUpper: Int?): Boolean =
  ageLower != null && ageLower >= 18 && (ageUpper == null || ageUpper >= 18)

// Under 18 only when the whole band is. A band that reaches past 18 without
// starting there ([16, null], or [0, 20] under custom ranges) could be either,
// so it is unconfirmed rather than called under 18.
internal fun sharedAgeVerdict(ageLower: Int?, ageUpper: Int?): AgeVerdict = when {
  ageLower == null -> AgeVerdict.Block(BlockReason.NotShared)
  adultBand(ageLower, ageUpper) -> AgeVerdict.Allow
  ageUpper != null && ageUpper < 18 -> AgeVerdict.Block(BlockReason.Underage)
  else -> AgeVerdict.Block(BlockReason.Unconfirmed)
}

// Amazon's own account of a query made before the API gives live answers:
// "null, Exception, or FEATURE_NOT_SUPPORTED". A device whose Appstore has no
// age provider at all (a Fire TV, an older Appstore) answers null as well.
// None of it is an answer about this user, so all of it opens, as
// FEATURE_NOT_SUPPORTED did from the start; stopping there would lock every
// such device out. A live answer is a row with a responseStatus.
internal val amazonNotLive: AgeVerdict = AgeVerdict.Allow

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
    // "The GetUserAgeData API is not enabled on this device. This can occur
    // on legacy devices that do not receive new feature support."
    "FEATURE_NOT_SUPPORTED" -> return amazonNotLive
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
      // Amazon's adult row is ageLower 18 and ageUpper null ("Always 18",
      // "Always null"). Anything else is not that contract. A bound under 18
      // is underage; the rest is unconfirmed, so a 19 with a missing upper
      // bound is not told they are under 18.
      if (ageLower == 18 && ageUpper == null) return AgeVerdict.Allow
      if (ageLower != null && ageLower < 18) return AgeVerdict.Block(BlockReason.Underage)
      if (ageUpper != null && ageUpper < 18) return AgeVerdict.Block(BlockReason.Underage)
      return AgeVerdict.Block(BlockReason.Unconfirmed)
    }
    "SUPERVISED" -> return AgeVerdict.Block(BlockReason.Underage)
    // A parent's consent only ever covers someone under 18, and this app
    // stays shut for them even with it, so they see the under-18 screen,
    // not one that suggests a parent could open it.
    "CONSENT_NOT_GRANTED" -> return AgeVerdict.Block(BlockReason.Underage)
    "UNKNOWN" -> return AgeVerdict.Block(BlockReason.Unconfirmed)
    else -> return AgeVerdict.Block(BlockReason.Unconfirmed)
  }
}
