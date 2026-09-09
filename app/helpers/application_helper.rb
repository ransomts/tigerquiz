module ApplicationHelper
  # Where the app is mounted: "/" normally, "/quiz/" behind a proxy serving it
  # from a sub-path. The pages build every URL they fetch from this, so the
  # prefix is configured once (RAILS_RELATIVE_URL_ROOT) and known everywhere.
  # Always ends in a slash, so joining a path onto it needs no thought.
  def app_base
    base = root_path
    base.end_with?("/") ? base : "#{base}/"
  end
end
