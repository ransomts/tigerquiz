# Who is making the request.
#
# Apache does the Shibboleth work and passes the result in one header (see
# config/deploy/apache.conf.example and PORT.md). Puma is only reachable through
# Apache, and Apache strips any incoming copy of that header before setting its
# own, so a value here is trustworthy. Outside production, TIGERQUIZ_DEV_USER
# stands in for the header so the app runs without any SSO at all.
module Authentication
  extend ActiveSupport::Concern

  included do
    helper_method :current_user, :signed_in?
  end

  def current_user
    return Current.user if Current.user

    eppn = request.headers[settings.user_header].presence
    eppn ||= settings.dev_user if Rails.env.local?
    return nil unless eppn

    user = User.find_or_create_by!(eppn: eppn.strip)
    name = request.headers[settings.name_header].presence
    user.update!(display_name: name) if name && user.display_name != name
    Current.user = user
  end

  def signed_in? = current_user.present?

  # For instructor pages and the API they call. Students never hit these.
  def require_user
    return if signed_in?

    respond_to do |format|
      format.json { render json: { error: "Sign in required" }, status: :unauthorized }
      format.any { render "errors/unauthorized", status: :unauthorized, layout: "application", formats: :html }
    end
  end

  private

  def settings = Rails.application.config.tigerquiz
end
