//! Native transport core: the UDP circuit, the HTTP capability proxy, XML-RPC
//! login, and the map and Destination Guide fetches all live here.

pub mod caps;
pub mod circuit;
pub mod eventqueue;
pub mod hwid;
pub mod login;
pub mod map;
pub mod proxy;
pub mod session;
pub mod state;
pub mod util;
