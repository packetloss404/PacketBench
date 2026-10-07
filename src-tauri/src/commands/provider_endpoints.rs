#[tauri::command]
pub fn get_provider_base_url(provider: String) -> Result<String, String> {
    crate::core::provider_endpoints::resolve(&provider)
}

#[tauri::command]
pub fn set_provider_base_url(provider: String, base_url: Option<String>) -> Result<String, String> {
    crate::core::provider_endpoints::default_base_url(&provider)?;
    let normalized = base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(crate::core::storage::normalize_custom_compat_base_url)
        .transpose()?;
    crate::core::storage::save_named_provider_base_url(&provider, normalized)?;
    crate::core::provider_endpoints::resolve(&provider)
}
