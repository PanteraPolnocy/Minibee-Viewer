package com.pantera.minibee_viewer

import com.google.android.play.agesignals.model.AgeSignalsErrorCode
import org.junit.Assert.assertEquals
import org.junit.Test

class AgePolicyTest {
  @Test
  fun onlyACopyAStoreInstalledHasAStoreToAsk() {
    assertEquals(InstallStore.Play, installStore("com.android.vending"))
    assertEquals(InstallStore.Amazon, installStore("com.amazon.venezia"))
    // The GitHub APK: installed by a file manager, a browser, adb or nobody
    // the system names.
    assertEquals(InstallStore.Other, installStore(null))
    assertEquals(InstallStore.Other, installStore(""))
    assertEquals(InstallStore.Other, installStore("com.google.android.packageinstaller"))
    assertEquals(InstallStore.Other, installStore("com.android.vending.evil"))
  }

  @Test
  fun adultBandStartsAtEighteen() {
    assertEquals(false, adultBand(null, null))
    assertEquals(false, adultBand(17, null))
    assertEquals(false, adultBand(16, 17))
    assertEquals(false, adultBand(18, 17))
    assertEquals(true, adultBand(18, null))
    assertEquals(true, adultBand(18, 18))
  }

  @Test
  fun sharedPlayBand() {
    assertEquals(AgeVerdict.Block(BlockReason.NotShared), sharedAgeVerdict(null, null))
    assertEquals(AgeVerdict.Block(BlockReason.Underage), sharedAgeVerdict(16, 17))
    assertEquals(AgeVerdict.Allow, sharedAgeVerdict(18, null))
    assertEquals(AgeVerdict.Allow, sharedAgeVerdict(21, null))
  }

  @Test
  fun aBandAcross18IsUnconfirmedNotUnderage() {
    // Play Console's custom age ranges can make these: 16 and over, or
    // 0 to 20 under a minimum age of 21.
    assertEquals(AgeVerdict.Block(BlockReason.Unconfirmed), sharedAgeVerdict(16, null))
    assertEquals(AgeVerdict.Block(BlockReason.Unconfirmed), sharedAgeVerdict(0, 20))
    assertEquals(AgeVerdict.Block(BlockReason.Underage), sharedAgeVerdict(0, 14))
  }

  @Test
  fun retriesFollowGooglesRetryableColumn() {
    for (code in -8..-1) assertEquals("code $code", true, isRetryablePlayError(code))
    assertEquals(true, isRetryablePlayError(AgeSignalsErrorCode.INTERNAL_ERROR))
    assertEquals(false, isRetryablePlayError(AgeSignalsErrorCode.APP_NOT_OWNED))
    assertEquals(false, isRetryablePlayError(AgeSignalsErrorCode.SDK_VERSION_OUTDATED))
    assertEquals(false, isRetryablePlayError(AgeSignalsErrorCode.DEVICE_NOT_SUPPORTED))
  }

  @Test
  fun aFailedPlayCheckSaysWhatToDo() {
    for (code in listOf(
      AgeSignalsErrorCode.API_NOT_AVAILABLE,
      AgeSignalsErrorCode.PLAY_STORE_NOT_FOUND,
      AgeSignalsErrorCode.PLAY_SERVICES_NOT_FOUND,
      AgeSignalsErrorCode.CANNOT_BIND_TO_SERVICE,
      AgeSignalsErrorCode.PLAY_STORE_VERSION_OUTDATED,
      AgeSignalsErrorCode.PLAY_SERVICES_VERSION_OUTDATED,
    )) {
      assertEquals("code $code", BlockReason.PlayNeedsUpdate, playBlockReason(code))
    }
    assertEquals(BlockReason.AppNeedsUpdate, playBlockReason(AgeSignalsErrorCode.SDK_VERSION_OUTDATED))
    for (code in listOf(
      AgeSignalsErrorCode.NETWORK_ERROR,
      AgeSignalsErrorCode.CLIENT_TRANSIENT_ERROR,
      AgeSignalsErrorCode.APP_NOT_OWNED,
      AgeSignalsErrorCode.DEVICE_NOT_SUPPORTED,
      AgeSignalsErrorCode.INTERNAL_ERROR,
    )) {
      assertEquals("code $code", BlockReason.StoreUnreachable, playBlockReason(code))
    }
    assertEquals(BlockReason.StoreUnreachable, playBlockReason(null))
  }

  @Test
  fun playDiscoveryDoesNotTreatSilenceAsPermission() {
    assertEquals(PlayFailure.Block, playDiscoveryFailure(null, storeInstall = true))
    assertEquals(
      PlayFailure.Block,
      playDiscoveryFailure(AgeSignalsErrorCode.APP_NOT_OWNED, storeInstall = true)
    )
    assertEquals(
      PlayFailure.Retry,
      playDiscoveryFailure(AgeSignalsErrorCode.NETWORK_ERROR, storeInstall = true)
    )
    assertEquals(
      PlayFailure.Block,
      playDiscoveryFailure(AgeSignalsErrorCode.SDK_VERSION_OUTDATED, storeInstall = true)
    )
    assertEquals(
      PlayFailure.Allow,
      playDiscoveryFailure(AgeSignalsErrorCode.DEVICE_NOT_SUPPORTED, storeInstall = true)
    )
  }

  @Test
  fun aPlayStoreTooOldToBeAskedStopsToo() {
    // The library answers these itself, without a call, when the Play Store
    // is older than the question. Tried again, then the screen asks for the
    // store to be updated: this does not open, in any country.
    for (code in listOf(
      AgeSignalsErrorCode.PLAY_STORE_VERSION_OUTDATED,
      AgeSignalsErrorCode.API_NOT_AVAILABLE,
    )) {
      assertEquals("code $code", PlayFailure.Retry, playDiscoveryFailure(code, storeInstall = true))
      assertEquals("code $code", PlayFailure.Retry, playMandatoryFailure(code))
      assertEquals("code $code", BlockReason.PlayNeedsUpdate, playBlockReason(code))
    }
  }

  @Test
  fun debugSideloadStillOpensWhenPlayDoesNotOwnIt() {
    assertEquals(
      PlayFailure.Allow,
      playDiscoveryFailure(AgeSignalsErrorCode.APP_NOT_OWNED, storeInstall = false)
    )
    assertEquals(PlayFailure.Allow, playDiscoveryFailure(null, storeInstall = false))
  }

  @Test
  fun amazonOnlyEmptySuccessSkipsTheCheck() {
    assertEquals(AgeVerdict.Allow, amazonVerdict("SUCCESS", "", null, null))
    assertEquals(AgeVerdict.Allow, amazonVerdict("SUCCESS", "VERIFIED", 18, null))
    assertEquals(
      AgeVerdict.Block(BlockReason.Unconfirmed),
      amazonVerdict("SUCCESS", "VERIFIED", 18, 18)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.Unconfirmed),
      amazonVerdict("SUCCESS", "VERIFIED", 19, null)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.Unconfirmed),
      amazonVerdict("SUCCESS", "VERIFIED", null, null)
    )
    assertEquals(AgeVerdict.Block(BlockReason.Unconfirmed), amazonVerdict("SUCCESS", " ", null, null))
    assertEquals(
      AgeVerdict.Block(BlockReason.Unconfirmed),
      amazonVerdict("SUCCESS", " VERIFIED", 18, null)
    )
    assertEquals(AgeVerdict.Retry, amazonVerdict(null, "", null, null))
    assertEquals(AgeVerdict.Retry, amazonVerdict("SUCCESS", null, 18, null))
    assertEquals(AgeVerdict.Allow, amazonVerdict("FEATURE_NOT_SUPPORTED", "", null, null))
    assertEquals(
      AgeVerdict.Block(BlockReason.Underage),
      amazonVerdict("SUCCESS", "SUPERVISED", 16, 17)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.Underage),
      amazonVerdict("SUCCESS", "VERIFIED", 16, 17)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.Unconfirmed),
      amazonVerdict("SUCCESS", "UNKNOWN", null, null)
    )
    assertEquals(AgeVerdict.Retry, amazonVerdict("INTERNAL_TRANSIENT_ERROR", "", null, null))
    assertEquals(
      AgeVerdict.Block(BlockReason.StoreUnreachable),
      amazonVerdict("INTERNAL_ERROR", "", null, null)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.StoreUnreachable),
      amazonVerdict("APP_NOT_OWNED", "", null, null)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.StoreUnreachable),
      amazonVerdict("SOMETHING_NEW", "", null, null)
    )
  }

  @Test
  fun amazonConsentIsOnlyEverAMinors() {
    // Revoked, pending or refused consent: someone under 18, whom this app
    // does not open for even with a parent's consent.
    assertEquals(
      AgeVerdict.Block(BlockReason.Underage),
      amazonVerdict("SUCCESS", "CONSENT_NOT_GRANTED", 0, 12)
    )
    assertEquals(
      AgeVerdict.Block(BlockReason.Underage),
      amazonVerdict("SUCCESS", "CONSENT_NOT_GRANTED", null, null)
    )
  }

  @Test
  fun amazonBeforeLiveAnswersOpens() {
    // No cursor, no row or a thrown query (AgeGateActivity.readAmazon), and
    // FEATURE_NOT_SUPPORTED: Amazon's three answers before the API is live.
    assertEquals(AgeVerdict.Allow, amazonNotLive)
    assertEquals(amazonNotLive, amazonVerdict("FEATURE_NOT_SUPPORTED", "", null, null))
  }
}
