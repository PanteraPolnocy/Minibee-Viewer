//! Native transport core: the UDP circuit, the HTTP capability proxy, XML-RPC
//! login, and the map and Destination Guide fetches all live here.

pub mod abuse;
pub mod caps;
pub mod circuit;
pub mod currency;
pub mod events;
pub mod eventqueue;
pub mod feeds;
pub mod http_client;
pub mod hwid;
pub mod inventory;
pub mod landmarks;
pub mod login;
pub mod map;
pub mod mfa;
pub mod netmeter;
pub mod notecards;
pub mod objects;
pub mod outfit;
pub mod platform;
pub mod proxy;
pub mod scripts;
pub mod session;
pub mod state;
pub mod util;
pub mod voice;
