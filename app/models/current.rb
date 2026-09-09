# Per-request state. Set by ApplicationController from the Shibboleth header.
class Current < ActiveSupport::CurrentAttributes
  attribute :user
end
