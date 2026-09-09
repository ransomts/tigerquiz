# The pages render nicknames students choose and quiz text instructors write.
# Both go into the DOM through textContent, never through innerHTML, so this is
# the second line of defence rather than the first -- but it is the line that
# holds if the first one is ever breached by a change made in a hurry.
Rails.application.configure do
  config.content_security_policy do |policy|
    policy.default_src :self
    policy.base_uri    :self
    policy.object_src  :none
    policy.form_action :self
    policy.frame_ancestors :self

    # Every page's own script is inline and carries the nonce below; everything
    # else is a compiled asset served from here.
    policy.script_src :self

    # 'unsafe_inline' is not an oversight. The host's results chart sizes each
    # bar with a style attribute computed per render (flex-grow from the vote
    # counts, left from a slider answer), and the same for the ghost bars of a
    # re-vote. Moving those to element.style in JS would take them out of CSP's
    # reach entirely and let this become :self; it is a separate change, and
    # script is where the injection risk actually lives.
    policy.style_src :self, :unsafe_inline

    # Question images are usually served from quizzes/images, but the quiz
    # format also accepts an https URL for one.
    policy.img_src   :self, :data, :https
    policy.font_src  :self
    # The websocket every screen holds open is on this same origin, and :self
    # covers ws:/wss: there. Verified in a browser rather than assumed.
    policy.connect_src :self
  end

  # A fresh nonce per response. The Rails default derives it from the session
  # id, which is stable for as long as the session is and is empty on the join
  # page, where students have no session at all.
  config.content_security_policy_nonce_generator = ->(_request) { SecureRandom.base64(16) }
  config.content_security_policy_nonce_directives = %w[script-src]
end
