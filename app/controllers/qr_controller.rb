# The QR code on the lobby screen, so phones can join without typing the address.
class QrController < ApplicationController
  def show
    text = params[:text].to_s[0, 300]
    return head :bad_request if text.empty?

    svg = RQRCode::QRCode.new(text).as_svg(color: "111111", fill: "ffffff", module_size: 6, standalone: true, use_path: true)
    render body: svg, content_type: "image/svg+xml"
  end
end
