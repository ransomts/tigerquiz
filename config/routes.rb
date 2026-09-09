Rails.application.routes.draw do
  get "up" => "rails/health#show", as: :rails_health_check

  get "api/me", to: "me#show", defaults: { format: :json }
end
