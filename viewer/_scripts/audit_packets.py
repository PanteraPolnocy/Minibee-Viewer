#!/usr/bin/env python3
"""Compare Minibee packet coverage against Firestorm message handlers."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

# Experiment root: parent of scripts/
ROOT = Path(__file__).resolve().parents[1]

MSG_TEMPLATE_PARTS = ('scripts', 'messages', 'message_template.msg')


def find_message_template(start: Path) -> Path | None:
    env = os.environ.get('SL_MSG_TEMPLATE', '').strip()
    if env:
        path = Path(env)
        if path.is_file():
            return path

    current = start.resolve()
    for _ in range(8):
        candidate = current.joinpath(*MSG_TEMPLATE_PARTS)
        if candidate.is_file():
            return candidate
        parent = current.parent
        if parent == current:
            break
        current = parent
    return None


def main() -> int:
    pkt_file = ROOT / 'js' / 'protocol' / 'sl-packet.js'
    binary_file = ROOT / 'js' / 'protocol' / 'sl-binary.js'
    msg_file = find_message_template(ROOT)

    missing = [p for p in (pkt_file, binary_file) if not p.is_file()]
    if missing:
        for path in missing:
            print(f'Missing required file: {path}', file=sys.stderr)
        return 2

    if not msg_file:
        print(
            'message_template.msg not found. Set SL_MSG_TEMPLATE or place the '
            'experiment inside a Firestorm-style tree.',
            file=sys.stderr,
        )
        return 2

    text = msg_file.read_text(encoding='utf-8', errors='replace')
    pat = re.compile(r'^\s+(\w+)\s+(Low|Medium|High|Fixed)\s+(\d+)', re.M)
    msgs: dict[str, tuple[str, int]] = {}
    for m in pat.finditer(text):
        name, freq, num = m.group(1), m.group(2), int(m.group(3))
        msgs[name] = (freq, num)

    pkt = pkt_file.read_text(encoding='utf-8')
    binary = binary_file.read_text(encoding='utf-8')
    registered = set(re.findall(r"name: '([^']+)'", pkt))
    registered |= set(re.findall(r"[HML]\(\d+, '([^']+)'", pkt))
    registered |= set(re.findall(r'^\s+(\w+):\s+\d+', binary, re.M))

    llstartup = '''LayerData ImageData ImagePacket ObjectUpdate ObjectUpdateCompressed ObjectUpdateCached ImprovedTerseObjectUpdate SimStats HealthMessage EconomyData RegionInfo ChatFromSimulator KillObject SimulatorViewerTimeMessage EnableSimulator DisableSimulator KickUser CrossedRegion TeleportFinish AlertMessage AgentAlertMessage MeanCollisionAlert ViewerFrozenMessage NameValuePair RemoveNameValuePair AvatarAnimation ObjectAnimation AvatarAppearance AgentCachedTextureResponse RebakeAvatarTextures CameraConstraint AvatarSitResponse SetFollowCamProperties ClearFollowCamProperties ImprovedInstantMessage ScriptQuestion ObjectProperties ObjectPropertiesFamily ForceObjectSelect MoneyBalanceReply CoarseLocationUpdate ReplyTaskInventory DerezContainer ScriptRunningReply DeRezAck LogoutReply AgentDataUpdate AgentGroupDataUpdate AgentDropGroup ParcelOverlay ParcelProperties ParcelAccessListReply ParcelDwellReply AvatarPropertiesReply AvatarInterestsReply AvatarGroupsReply AvatarNotesReply AvatarPicksReply AvatarClassifiedReply CreateGroupReply JoinGroupReply EjectGroupMemberReply LeaveGroupReply GroupProfileReply AgentWearablesUpdate ScriptControlChange ViewerEffect GrantGodlikePowers GroupAccountSummaryReply GroupAccountDetailsReply GroupAccountTransactionsReply UserInfoReply RegionHandshake TeleportStart TeleportProgress TeleportFailed TeleportLocal ImageNotInDatabase GroupMembersReply GroupRoleDataReply GroupRoleMembersReply GroupTitlesReply PlacesReply GroupNoticesListReply AvatarPickerReply DirPlacesReply DirPeopleReply DirEventsReply DirGroupsReply DirClassifiedReply DirLandReply MapBlockReply MapItemReply EventInfoReply PickInfoReply ClassifiedInfoReply ParcelInfoReply ScriptDialog LoadURL ScriptTeleportRequest EstateCovenantReply OfferCallingCard AcceptCallingCard DeclineCallingCard ParcelObjectOwnersReply InitiateDownload LandStatReply GenericMessage GenericStreamingMessage LargeGenericMessage FeatureDisabled SoundTrigger PreloadSound AttachedSound AttachedSoundGainChange'''.split()

    extra_handlers = '''TelehubInfo ParcelMediaCommandMessage ParcelMediaUpdate FindAgent OnlineNotification OfflineNotification TerminateFriendship ChangeUserRights PayPriceReply UpdateCreateInventoryItem RemoveInventoryItem RemoveInventoryFolder RemoveInventoryObjects SaveAssetIntoInventory BulkUpdateInventory MoveInventoryItem InventoryDescendents FetchInventoryReply DataHomeLocationRequest DataHomeLocationReply NeighborList AgentAnimation MultipleObjectUpdate MapLayerReply ConfirmEnableSimulator'''.split()

    all_handlers = set(llstartup) | set(extra_handlers)
    missing_reg = sorted(n for n in all_handlers if n not in registered)
    print('Handlers not in sl-packet registration:', len(missing_reg))
    for n in missing_reg:
        info = msgs.get(n, ('?', '?'))
        print(f'  {n}: {info[0]} {info[1]}')

    outbound = '''UseCircuitCode CompleteAgentMovement RegionHandshakeReply AgentDataUpdateRequest ChatFromViewer ImprovedInstantMessage AgentUpdate ParcelPropertiesRequest ParcelPropertiesRequestByID ParcelInfoRequest UUIDNameRequest LogoutRequest StartPingCheck CompletePingCheck TeleportLocationRequest TeleportLandmarkRequest TeleportCancel MapBlockRequest MapNameRequest MapItemRequest ParcelPropertiesUpdate ScriptDialogReply StartLure TeleportLureRequest MoneyBalanceRequest'''.split()
    missing_out: list[tuple[str, str]] = []
    for n in outbound:
        if f'{n}:' not in binary:
            missing_out.append((n, 'no constant'))
        elif f'case M.{n}:' not in pkt:
            missing_out.append((n, 'no buildBody case'))

    print('\nOutbound gaps:', len(missing_out))
    for n, why in missing_out:
        info = msgs.get(n, ('?', '?'))
        print(f'  {n}: {why} ({info[0]} {info[1]})')

    return 1 if missing_reg or missing_out else 0


if __name__ == '__main__':
    raise SystemExit(main())
