use std::net::{IpAddr, SocketAddr};

use axum::http::{HeaderMap, HeaderName};

const UNKNOWN_IP: &str = "unknown";
const X_FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");

/// The client address that rate-limit keys are built from.
///
/// With `hops == 0` the server is reached directly, so this is the peer address.
/// With `hops > 0` the server sits behind that many trusted proxies, each of which
/// appends the address it received to `X-Forwarded-For`, so the client is the entry
/// `hops` positions from the right. A missing, malformed or too short header falls
/// back to the peer address.
pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>, hops: u8) -> String {
    let peer_ip = || peer.map_or_else(|| UNKNOWN_IP.to_string(), |addr| addr.ip().to_string());
    if hops == 0 {
        return peer_ip();
    }
    forwarded_client(headers, hops).map_or_else(peer_ip, |ip| ip.to_string())
}

fn forwarded_client(headers: &HeaderMap, hops: u8) -> Option<IpAddr> {
    let mut entries = Vec::new();
    for value in headers.get_all(X_FORWARDED_FOR) {
        entries.extend(value.to_str().ok()?.split(',').map(str::trim));
    }
    let index = entries.len().checked_sub(usize::from(hops))?;
    entries.get(index)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn peer() -> Option<SocketAddr> {
        Some("192.0.2.10:4444".parse().unwrap())
    }

    fn forwarded(values: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for value in values {
            headers.append(X_FORWARDED_FOR, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    #[test]
    fn zero_hops_uses_the_peer_and_ignores_the_header() {
        let headers = forwarded(&["203.0.113.9"]);

        assert_eq!(client_ip(&headers, peer(), 0), "192.0.2.10");
    }

    #[test]
    fn zero_hops_without_a_peer_is_unknown() {
        assert_eq!(client_ip(&HeaderMap::new(), None, 0), "unknown");
    }

    #[test]
    fn one_hop_takes_the_last_entry() {
        let headers = forwarded(&["203.0.113.9"]);

        assert_eq!(client_ip(&headers, peer(), 1), "203.0.113.9");
    }

    #[test]
    fn one_hop_ignores_entries_added_before_the_nearest_proxy() {
        let headers = forwarded(&["198.51.100.66, 203.0.113.9"]);

        assert_eq!(client_ip(&headers, peer(), 1), "203.0.113.9");
    }

    #[test]
    fn two_hops_takes_the_second_entry_from_the_right() {
        let headers = forwarded(&["198.51.100.66, 203.0.113.9, 192.0.2.1"]);

        assert_eq!(client_ip(&headers, peer(), 2), "203.0.113.9");
    }

    #[test]
    fn entries_are_trimmed() {
        let headers = forwarded(&[" 198.51.100.1 ,  203.0.113.9  "]);

        assert_eq!(client_ip(&headers, peer(), 1), "203.0.113.9");
        assert_eq!(client_ip(&headers, peer(), 2), "198.51.100.1");
    }

    #[test]
    fn repeated_header_lines_form_one_list() {
        let headers = forwarded(&["198.51.100.1", "203.0.113.9"]);

        assert_eq!(client_ip(&headers, peer(), 2), "198.51.100.1");
    }

    #[test]
    fn ipv6_entries_are_accepted() {
        let headers = forwarded(&["2001:db8::7"]);

        assert_eq!(client_ip(&headers, peer(), 1), "2001:db8::7");
    }

    #[test]
    fn missing_header_falls_back_to_the_peer() {
        assert_eq!(client_ip(&HeaderMap::new(), peer(), 1), "192.0.2.10");
    }

    #[test]
    fn missing_header_without_a_peer_is_unknown() {
        assert_eq!(client_ip(&HeaderMap::new(), None, 1), "unknown");
    }

    #[test]
    fn fewer_entries_than_hops_falls_back_to_the_peer() {
        let headers = forwarded(&["203.0.113.9"]);

        assert_eq!(client_ip(&headers, peer(), 2), "192.0.2.10");
    }

    #[test]
    fn non_utf8_header_falls_back_to_the_peer() {
        let mut headers = HeaderMap::new();
        headers.append(X_FORWARDED_FOR, HeaderValue::from_bytes(b"\xff").unwrap());

        assert_eq!(client_ip(&headers, peer(), 1), "192.0.2.10");
    }

    #[test]
    fn entry_that_is_not_an_ip_falls_back_to_the_peer() {
        for value in ["unknown", "203.0.113.9:443", "", "203.0.113.9,"] {
            assert_eq!(
                client_ip(&forwarded(&[value]), peer(), 1),
                "192.0.2.10",
                "{value:?}"
            );
        }
    }
}
