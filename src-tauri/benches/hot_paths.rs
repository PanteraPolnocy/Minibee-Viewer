use criterion::{black_box, criterion_group, criterion_main, Criterion};

use minibee_viewer_lib::bridge::objects::{id_bytes, id_string, perm_mask_text, ObjectRow, ObjectTable, ListFilters, PCODE_PRIM};
use minibee_viewer_lib::bridge::util::{llsd_cap_map, normalize_seed_url, uuid_to_bytes, xml_escape};
use minibee_viewer_lib::codec::{self, template};
use minibee_viewer_lib::urlmatch::{classify_external_url, linkify};

fn bench_linkify(c: &mut Criterion) {
    let chat = "come to secondlife://Natoma/128/64/25 or http://maps.secondlife.com/secondlife/Natoma/128/64/25 \
        and mail bob@example.com or visit https://community.secondlife.com/blog for [http://evil.com  click me]";
    c.bench_function("urlmatch::linkify_mixed", |b| {
        b.iter(|| linkify(black_box(chat)));
    });
}

fn bench_uuid(c: &mut Criterion) {
    let id = [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
    let text = "00112233-4455-6677-8899-aabbccddeeff";
    c.bench_function("objects::id_string", |b| b.iter(|| id_string(black_box(&id))));
    c.bench_function("objects::id_bytes", |b| b.iter(|| id_bytes(black_box(text))));
    c.bench_function("util::uuid_to_bytes", |b| b.iter(|| uuid_to_bytes(black_box(text))));
}

fn bench_codec(c: &mut Criterion) {
    let reg = template::build_registry();
    let mut buf = vec![0x00, 0, 0, 0, 1, 0];
    buf.extend_from_slice(&[0xFF, 0xFF, 0x00, 0x50]);
    buf.extend_from_slice(&[1, 0, 0, 0, 2, 9]);
    let end = buf.len() - 1;
    let enc = codec::zerocode_encode(&buf, 6, end);
    c.bench_function("codec::zerocode_expand", |b| {
        b.iter(|| codec::zerocode_expand(black_box(&enc)));
    });
    c.bench_function("codec::decode_chat_template", |b| {
        b.iter(|| {
            let blocks = serde_json::json!({
                "AgentData": [{ "AgentID": "11111111-1111-1111-1111-111111111111", "SessionID": "22222222-2222-2222-2222-222222222222" }],
                "ChatData": [{ "Message": "aGVsbG8A", "Type": 1, "Channel": 0 }]
            });
            codec::encode(black_box(&reg), "ChatFromViewer", &blocks, 7, codec::FLAG_RELIABLE)
        });
    });
}

fn bench_objects(c: &mut Criterion) {
    c.bench_function("objects::perm_mask_text", |b| {
        b.iter(|| perm_mask_text(black_box(0x7)));
    });
}

fn bench_util(c: &mut Criterion) {
    let body = "<llsd><map>\
        <key>EventQueueGet</key><uri>https://sim/cap/eq</uri>\
        <key>GetDisplayNames</key><string>https://sim/cap/dn</string>\
        </map></llsd>";
    c.bench_function("util::llsd_cap_map", |b| {
        b.iter(|| llsd_cap_map(black_box(body)));
    });
    c.bench_function("util::xml_escape", |b| {
        b.iter(|| xml_escape(black_box("a<b>&\"'")));
    });
    let seed = "https://simhost-1234/abcdef.agni.secondlife.io:12043/cap/foo";
    c.bench_function("util::normalize_seed_url", |b| {
        b.iter(|| normalize_seed_url(black_box(seed)));
    });
}

fn bench_classify(c: &mut Criterion) {
    c.bench_function("urlmatch::classify_external_url", |b| {
        b.iter(|| classify_external_url(black_box("https://community.secondlife.com/blog")));
    });
}

fn bench_nearby_list(c: &mut Criterion) {
    let mut table = ObjectTable::default();
    for i in 0..200u32 {
        let mut row = ObjectRow::default();
        row.local_id = i + 1;
        row.full_id[0] = (i + 1) as u8;
        row.pcode = PCODE_PRIM;
        row.pos = [
            128.0 + (i as f32 % 20.0),
            128.0 + (i as f32 / 20.0),
            25.0,
        ];
        table.upsert(row);
    }
    let from = [128.0, 128.0, 25.0];
    let filters = ListFilters {
        include_attachments: true,
        include_physical: true,
    };
    c.bench_function("objects::nearby_list_entries_200", |b| {
        b.iter(|| table.nearby_list_entries(black_box(from), black_box(96.0), filters));
    });
}

criterion_group!(
    benches,
    bench_linkify,
    bench_uuid,
    bench_codec,
    bench_objects,
    bench_util,
    bench_classify,
    bench_nearby_list
);
criterion_main!(benches);
