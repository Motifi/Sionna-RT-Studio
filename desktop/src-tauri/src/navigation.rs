use tauri::Url;

pub const EXTERNAL_LINK_PATH: &str = "/__studio_desktop_external_link";

pub fn is_studio_page(url: &Url, origin: &Url) -> bool {
    url.scheme() == origin.scheme()
        && url.host() == origin.host()
        && url.port_or_known_default() == origin.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn is_studio_resource(url: &Url, origin: &Url) -> bool {
    if let Some(inner) = url.as_str().strip_prefix("blob:") {
        return Url::parse(inner).is_ok_and(|inner| is_studio_page(&inner, origin));
    }
    is_studio_page(url, origin)
}

pub fn is_bootstrap_page(url: &Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && matches!(url.path(), "/" | "/index.html")
        && url.username().is_empty()
        && url.password().is_none()
}

fn external_target(request: &Url, token: &str) -> Option<Url> {
    let (_, supplied_token) = request.query_pairs().find(|(key, _)| key == "token")?;
    if supplied_token != token {
        return None;
    }
    let (_, address) = request.query_pairs().find(|(key, _)| key == "url")?;
    let target = Url::parse(&address).ok()?;
    (target.scheme() == "https"
        && target.host().is_some()
        && target.username().is_empty()
        && target.password().is_none())
    .then_some(target)
}

pub fn open_external(request: &Url, token: &str) {
    if let Some(target) = external_target(request, token) {
        if let Err(error) = tauri_plugin_opener::open_url(target.as_str(), None::<&str>) {
            eprintln!("Could not open link: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn studio_resources_include_loopback_http_and_its_blob_downloads() {
        let origin = Url::parse("http://127.0.0.1:43110/").unwrap();
        for url in [
            "http://127.0.0.1:43110/api/health",
            "blob:http://127.0.0.1:43110/ea9cf91e-445a-4bed-8ad8-64c792bfa62d",
        ] {
            assert!(is_studio_resource(&Url::parse(url).unwrap(), &origin));
        }
        for url in [
            "http://127.0.0.1:43111/",
            "http://127.0.0.1:43110@github.com/",
            "https://127.0.0.1:43110/",
            "file:///tmp/scene.xml",
            "blob:https://github.com/ea9cf91e-445a-4bed-8ad8-64c792bfa62d",
        ] {
            assert!(!is_studio_resource(&Url::parse(url).unwrap(), &origin));
        }
    }

    #[test]
    fn external_bridge_requires_a_token_and_https_without_credentials() {
        let request = |url: &str, token: &str| {
            let mut request =
                Url::parse("http://127.0.0.1:43110/__studio_desktop_external_link").unwrap();
            request
                .query_pairs_mut()
                .append_pair("url", url)
                .append_pair("token", token);
            request
        };
        assert!(external_target(&request("https://github.com/", "token"), "token").is_some());
        assert!(external_target(&request("https://github.com/", "other"), "token").is_none());
        for url in [
            "http://github.com/",
            "https://user@github.com/",
            "file:///tmp/studio",
        ] {
            assert!(external_target(&request(url, "token"), "token").is_none());
        }
    }
}
