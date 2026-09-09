# Question images: files an instructor drops in the images directory.
# Only the file name is honoured, so nothing outside the directory is reachable.
class ImagesController < ApplicationController
  def show
    name = File.basename(params[:name].to_s)
    path = Rails.application.config.tigerquiz.image_dir.join(name)
    return head :not_found unless name.present? && path.file?

    send_file path, type: Marcel::MimeType.for(path), disposition: "inline"
  end
end
